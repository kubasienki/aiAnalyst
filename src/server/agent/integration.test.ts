import { createAgentPreflight } from "../config/agent-preflight";
import { projectConversation } from "../conversations/display";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConversationRepository } from "../adapters/persistence/repository";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { answerSchema, clarificationSchema, runSqlArgumentsSchema, type AnalysisOutcome } from "../analysis/contracts";
import { createContextBuilder } from "../context/builder";
import { measureContextRequest } from "../context/budget";
import { projectEvidence } from "../context/evidence";
import type { ConversationRun, EvidenceInput } from "../conversations/contracts";
import type { ConversationRepository } from "../conversations/repository";
import { createExecutionContext } from "../data/execution-context";
import { createQueryService } from "../data/query-service";
import { REFERENCE_QUERIES } from "../data/reference-queries";
import { SEMANTIC_GUIDE_VERSION } from "../data/semantic-guide";
import type { ExecutionContext } from "../data/types";
import type { ModelRequest, ModelResponse, RegisteredTool, ToolCall } from "./contracts";
import { ModelError } from "./errors";
import { createAgentRunner } from "./runner";
import type { AgentCheckpoint } from "./runner-contracts";
import { registerTool } from "./tool-registration";

const versions = { model: "test/model", prompt: "analyst-v1", tools: "tools-v1", semanticGuide: SEMANTIC_GUIDE_VERSION };
const budget = { contextWindowTokens: 65_536, safetyTokens: 2_048 };
const measurer = createOpenRouterRequestMeasurer(versions.model);
const buildContext = createContextBuilder({ measurer, budget });
const repositories: ConversationRepository[] = [];
const directories: string[] = [];

type ApplicationState = { execution: ExecutionContext; visibleEvidenceIds: Set<string> };
type Checkpoint = AgentCheckpoint<AnalysisOutcome, EvidenceInput>;
type Tool = RegisteredTool<ApplicationState, AnalysisOutcome, EvidenceInput>;

function toolCall(name: string, argumentsValue: unknown): ToolCall {
  return { callId: randomUUID(), name, argumentsJson: JSON.stringify(argumentsValue) };
}

function response(...toolCalls: ToolCall[]): ModelResponse {
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, toolCalls } };
}

function answerArguments(evidenceIds: string[] = []) {
  return { narrative: "Observed revenue is 12.50 USD.", assumptions: [], limitations: [], evidenceIds, completeness: "complete" };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hockeystack-agent-integration-"));
  directories.push(directory);
  const databasePath = join(directory, "history.sqlite");
  let repository = open();
  const conversation = await repository.createConversation();
  const query = createQueryService({
    maximumBytesBilled: "1000",
    gateway: {
      async dryRun() { return { estimatedBytes: "100" }; },
      async submit() {
        return {
          id: "integration-job",
          async readPage() {
            return { complete: true, columns: [{ name: "revenue_usd", type: "NUMERIC" }], rows: [{ revenue_usd: "12.50" }] };
          },
          async statistics() { return { bytesProcessed: "100", bytesBilled: "100", cacheHit: false }; },
          async cancel() {},
        };
      },
    },
  });

  function open(): ConversationRepository {
    const opened = openConversationRepository({ databasePath });
    repositories.push(opened);
    return opened;
  }

  function tools(): Tool[] {
    return [
      registerTool({
        name: "run_sql", description: "Get bounded query evidence", role: "continuing",
        argumentsSchema: runSqlArgumentsSchema,
        async handle(argumentsValue, invocation) {
          const state = invocation.applicationContext;
          state.execution.signal = invocation.signal;
          const result = await query({ sql: argumentsValue.sql }, state.execution);
          if (!result.ok) {
            return { kind: "error", error: result.error };
          }
          const artifact: EvidenceInput = {
            evidence: result.evidence,
            semanticGuideSnapshot: "Event-level revenue in USD.",
            assumptions: [],
          };
          const content = projectEvidence(artifact);
          invocation.checkContinuation(content);
          return { kind: "continue", content, artifact };
        },
      }),
      registerTool({
        name: "finish_answer", description: "Finish a supported answer", role: "terminal",
        argumentsSchema: answerSchema,
        async handle(answer, invocation) {
          if (answer.evidenceIds.some(id => !invocation.applicationContext.visibleEvidenceIds.has(id))) {
            return { kind: "error", error: { code: "missing_evidence", message: "Use evidence supplied in this attempt's context." } };
          }
          return { kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "answer", answer } };
        },
      }),
      registerTool({
        name: "request_clarification", description: "Ask the user a focused question", role: "terminal",
        argumentsSchema: clarificationSchema,
        async handle(clarification) {
          return { kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "clarification", clarification } };
        },
      }),
    ];
  }

  async function start(message: string): Promise<ConversationRun> {
    const result = await repository.startRun({
      conversationId: conversation.id, expectedRevision: projectConversation(await repository.loadHistory(conversation.id)).revision, clientMessageId: randomUUID(), message,
      deadline: Date.now() + 120_000, versions,
    });
    return result.run;
  }

  async function attempt(
    run: ConversationRun,
    complete: (request: ModelRequest) => Promise<ModelResponse>,
    beforeCheckpoint?: (event: Checkpoint) => void,
  ) {
    const signal = new AbortController().signal;
    const registeredTools = tools();
    const context = buildContext({
      history: await repository.loadHistory(conversation.id), targetRunId: run.id,
      instructions: ["Use evidence and terminal tools."],
      requestSettings: {
        tools: registeredTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        toolSelection: { kind: "required" }, maxOutputTokens: 4_096, signal, deadline: run.deadline,
      },
    });
    const state: ApplicationState = {
      execution: createExecutionContext({ signal, deadline: run.deadline }),
      visibleEvidenceIds: new Set(context.includedEvidenceIds),
    };
    const runner = createAgentRunner({
      model: { complete }, preflight: createAgentPreflight(request => measureContextRequest(request, measurer, budget)),
    });
    const result = await runner({
      messages: context.messages, tools: registeredTools, applicationContext: state,
      signal, deadline: run.deadline,
      async checkpoint(event: Checkpoint) {
        beforeCheckpoint?.(event);
        switch (event.kind) {
          case "assistant":
            await repository.appendAssistant(run.id, event.response.message);
            break;
          case "context_note":
            await repository.appendContextNote(run.id, event.content);
            break;
          case "tool_result":
            if (event.artifact) {
              const evidenceId = event.artifact.evidence.resultId;
              await repository.recordToolResult(run.id, {
                callId: event.callId, payload: { kind: "evidence", evidenceId },
              }, event.artifact);
              state.visibleEvidenceIds.add(evidenceId);
            } else {
              await repository.recordToolResult(run.id, {
                callId: event.callId, payload: { kind: "inline", content: event.content },
              });
            }
            break;
          case "terminal":
            await repository.finishRun(run.id, {
              acknowledgment: { callId: event.callId, payload: { kind: "inline", content: event.acknowledgment } },
              outcome: event.outcome,
            });
            break;
        }
      },
    });
    // The application owns failure finalization; the generic runner does not.
    if (result.kind === "failure") {
      await repository.finishRun(run.id, {
        outcome: { kind: "failure", status: result.error.code === "cancelled" ? "cancelled" : "failed", error: result.error },
      });
    }
    return result;
  }

  return {
    start, attempt, conversation,
    history: () => repository.loadHistory(conversation.id),
    reopen() {
      repository.close();
      repository = open();
    },
    async retry(run: ConversationRun) {
      return (await repository.retryRun({
        conversationId: conversation.id, expectedRevision: projectConversation(await repository.loadHistory(conversation.id)).revision, runId: run.id, clientMessageId: randomUUID(),
        deadline: Date.now() + 120_000, versions,
      })).run;
    },
  };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("composed agent foundations", () => {
  it("persists a query and answer, then supplies the same evidence and accepted outcome after reopening", async () => {
    const f = await fixture();
    const run = await f.start("December revenue?");
    const complete = vi.fn(async (request: ModelRequest) => {
      if (request.messages.at(-1)?.role === "user") {
        return response(toolCall("run_sql", { intent: "December purchase revenue in USD", sql: REFERENCE_QUERIES.decemberRevenue }));
      }
      const evidence = (await f.history()).evidence[0];
      return response(toolCall("finish_answer", answerArguments([evidence.evidence.resultId])));
    });
    expect(await f.attempt(run, complete)).toMatchObject({ kind: "terminal", outcome: { kind: "answer" } });
    const saved = await f.history();
    const evidenceId = saved.evidence[0].evidence.resultId;
    const liveEvidence = complete.mock.calls[1][0].messages.at(-1);
    expect(liveEvidence).toEqual({ role: "tool", callId: expect.any(String), content: projectEvidence(saved.evidence[0]) });
    f.reopen();
    expect(await f.history()).toEqual(saved);
    const followUp = await f.start("Explain the result");
    const followUpModel = vi.fn(async (request: ModelRequest) => {
      expect(request.messages).toContainEqual(liveEvidence);
      expect(request.messages).toContainEqual(expect.objectContaining({
        role: "tool", content: { acknowledgment: { accepted: true }, outcome: saved.runs[0].outcome },
      }));
      return response(toolCall("finish_answer", answerArguments([evidenceId])));
    });
    expect(await f.attempt(followUp, followUpModel)).toMatchObject({ kind: "terminal" });
    expect((await f.history()).evidence).toHaveLength(1);
  });

  it("continues clarification after reopening and retries a failed answer to the same question", async () => {
    const f = await fixture();
    const run = await f.start("Which revenue?");
    const clarification = { question: "Which period?", choices: ["November", "December"] };
    expect(await f.attempt(run, async () => response(toolCall("request_clarification", clarification))))
      .toMatchObject({ kind: "terminal", outcome: { kind: "clarification" } });
    f.reopen();
    const followUp = await f.start("December");
    const failedModel = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => {
      expect(JSON.stringify(request.messages)).toContain("Which period?");
      throw new ModelError("provider", "Safe provider failure");
    });
    expect(await f.attempt(followUp, failedModel)).toMatchObject({ kind: "failure", error: { code: "provider" } });
    f.reopen();
    const retry = await f.retry(followUp);
    expect(retry.userMessageEventId).toBe(followUp.userMessageEventId);
    expect(await f.attempt(retry, async request => {
      expect(request.messages.at(-1)).toEqual({ role: "user", content: "December" });
      return response(toolCall("request_clarification", { question: "Which metric?" }));
    })).toMatchObject({ kind: "terminal" });
    const history = await f.history();
    expect(history.events.filter(event => event.payload.kind === "user_message")).toHaveLength(2);
    expect(history.runs.map(item => item.status)).toEqual(["waiting_for_user", "failed", "waiting_for_user"]);
  });

  it("rejects an answer referencing evidence that was never supplied and persists repair feedback", async () => {
    const f = await fixture();
    const run = await f.start("Revenue?");
    let requests = 0;
    const result = await f.attempt(run, async request => {
      requests++;
      if (requests === 1) {
        return response(toolCall("finish_answer", answerArguments([randomUUID()])));
      }
      expect(request.messages.at(-1)).toMatchObject({ role: "tool", content: { ok: false, error: { code: "missing_evidence" } } });
      return response(toolCall("request_clarification", { question: "Which period?" }));
    });
    expect(result).toMatchObject({ kind: "terminal", outcome: { kind: "clarification" } });
    const history = await f.history();
    expect(history.runs[0].outcome?.kind).toBe("clarification");
    expect(history.evidence).toEqual([]);
  });

  it("preserves a failed partial batch, omits the entire interaction on retry, and completes after reopening", async () => {
    const f = await fixture();
    const run = await f.start("Revenue?");
    let resultsWritten = 0;
    const batch = response(toolCall("run_sql", {}), toolCall("finish_answer", answerArguments()));
    expect(await f.attempt(run, async () => batch, event => {
      if (event.kind === "tool_result") {
        resultsWritten++;
        if (resultsWritten === 2) {
          throw new Error("Simulated checkpoint failure");
        }
      }
    })).toMatchObject({ kind: "failure", error: { code: "persistence" } });
    const failedHistory = await f.history();
    expect(failedHistory.events.filter(event => event.payload.kind === "tool_result")).toHaveLength(1);
    f.reopen();
    const retry = await f.retry(run);
    expect(await f.attempt(retry, async request => {
      expect(request.messages.some(message => message.role === "assistant")).toBe(false);
      expect(request.messages.some(message => message.role === "tool")).toBe(false);
      return response(toolCall("request_clarification", { question: "Which period?" }));
    })).toMatchObject({ kind: "terminal" });
    expect((await f.history()).events.slice(0, failedHistory.events.length)).toEqual(failedHistory.events);
  });
});
