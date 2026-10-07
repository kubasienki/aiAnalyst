import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModel, ModelRequest, ModelResponse, ToolInvocationContext } from "../agent/contracts";
import { createAgentRunner } from "../agent/runner";
import { openConversationRepository } from "../adapters/persistence/repository";
import { projectConversation } from "../conversations/display";
import { createContextBuilder } from "../context/builder";
import { ContextError } from "../context/contracts";
import { projectEvidence, projectUnavailableEvidence } from "../context/evidence";
import type { EvidenceInput, StoredEvidence } from "../conversations/contracts";
import { createExecutionContext } from "../data/execution-context";
import { SEMANTIC_GUIDE, SEMANTIC_GUIDE_VERSION } from "../data/semantic-guide";
import type { QueryEvidence, QueryExecutor } from "../data/types";
import { ANALYSIS_TOOL_DESCRIPTIONS, runSqlArgumentsSchema } from "./contracts";
import { buildAnalystInstructions } from "./prompt";
import { createAnalysisService } from "./service";
import { createAnalysisTools } from "./tools";
import type { AnalysisCheckpoint, AnalysisRunInput, AnalysisRunState } from "./types";

const conversationId = randomUUID();
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function evidence(overrides: Partial<QueryEvidence> = {}): QueryEvidence {
  const columns = [{ name: "revenue_usd", type: "FLOAT" }];
  const rows = [{ revenue_usd: 160555 }];
  return {
    resultId: randomUUID(), sql: "SELECT revenue", columns, rows,
    payloadBytes: Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8"),
    truncated: false, jobId: "test-job", estimatedBytes: "100",
    statistics: { bytesProcessed: "100", bytesBilled: "100", cacheHit: false },
    elapsedMs: 1, semanticGuideVersion: SEMANTIC_GUIDE_VERSION, ...overrides,
  };
}

function savedEvidence(result = evidence()): StoredEvidence {
  return {
    evidence: result, semanticGuideSnapshot: SEMANTIC_GUIDE, declaredScope: { intent: "December revenue in USD" },
    assumptions: [], conversationId, runId: randomUUID(), createdAt: 1,
  };
}

function action(name: string, args: unknown): ModelResponse {
  return {
    message: { role: "assistant", content: null, toolCalls: [{ callId: randomUUID(), name, argumentsJson: JSON.stringify(args) }] },
    finishReason: "tool_calls",
  };
}

function answer(evidenceIds: string[] = [], overrides = {}) {
  return { basis: "data", narrative: "Revenue was $160,555 in December 2020.", assumptions: [], limitations: [], evidenceIds, completeness: "complete", charts: [], ...overrides };
}

function runInput(overrides: Partial<AnalysisRunInput> = {}): AnalysisRunInput {
  return {
    conversationId, context: { messages: [{ role: "user", content: "December revenue?" }], includedEvidenceIds: [] },
    storedEvidence: [], signal: new AbortController().signal, deadline: Date.now() + 10_000,
    checkpoint: vi.fn(async () => undefined), ...overrides,
  };
}

function modelSequence(...steps: ((request: ModelRequest) => ModelResponse)[]): AgentModel {
  let index = 0;
  return { async complete(request) {
    const step = steps[index++];
    if (!step) throw new Error("Unexpected model request");
    return step(request);
  } };
}

function toolInvocation(visible = new Map<string, EvidenceInput>()): ToolInvocationContext<AnalysisRunState> {
  const queryExecution = createExecutionContext();
  return { applicationContext: { queryExecution, visibleEvidence: visible }, signal: queryExecution.signal,
    deadline: queryExecution.deadline, checkContinuation: vi.fn() };
}

function tool(name: string, executeQuery: QueryExecutor = vi.fn<QueryExecutor>()) {
  const found = createAnalysisTools(executeQuery).find(candidate => candidate.name === name);
  if (!found) throw new Error("Missing tool");
  return found;
}

function analyzeWith(model: AgentModel, executeQuery: QueryExecutor, preflight: (request: ModelRequest) => void = () => undefined) {
  return createAnalysisService({ executeQuery, runAgent: createAgentRunner({ model, preflight }) });
}

describe("analytical tools", () => {
  it("requires intent and enforces the UTF-8 SQL byte limit", () => {
    expect(runSqlArgumentsSchema.safeParse({ sql: "SELECT 1" }).success).toBe(false);
    expect(runSqlArgumentsSchema.safeParse({ intent: "Scope", sql: "界".repeat(11_000) }).success).toBe(false);
    expect(runSqlArgumentsSchema.safeParse({ intent: "Scope", sql: "SELECT 1" }).success).toBe(true);
  });

  it("looks up hidden GA4 tags locally without calling the warehouse", async () => {
    const execute: QueryExecutor = vi.fn<QueryExecutor>();
    const result = await tool("inspect_dataset", execute).execute(
      { topic: "view_item_list item_list_name" }, toolInvocation(),
    );
    expect(result).toMatchObject({ kind: "continue" });
    expect(JSON.stringify(result)).toContain("item_list_name STRING");
    expect(JSON.stringify(result)).toContain("does not read or count BigQuery");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["invalid_query", "rejected_sql", "processing_limit"] as const)("returns safe deterministic %s feedback", async code => {
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: false, error: { code, message: "Safe correction." } }));
    expect(await tool("run_sql", execute).execute({ intent: "Revenue", sql: "SELECT 1" }, toolInvocation()))
      .toMatchObject({ kind: "error", error: { code }, repeatPolicy: "unchanged_arguments" });
  });

  it.each(["cancelled", "deadline"] as const)("propagates %s as a stop", async code => {
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: false, error: { code, message: "Stopped." } }));
    await expect(tool("run_sql", execute).execute({ intent: "Revenue", sql: "SELECT 1" }, toolInvocation()))
      .rejects.toMatchObject({ code });
  });

  it("preflights full evidence, retains its artifact, and does not mutate visibility", async () => {
    const result = evidence();
    const invocation = toolInvocation();
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async (_, context) => {
      expect(context.signal).toBe(invocation.signal);
      expect(context.deadline).toBe(invocation.deadline);
      expect(context.budget).toBe(invocation.applicationContext.queryExecution.budget);
      return { ok: true, evidence: result };
    });
    const output = await tool("run_sql", execute).execute({ intent: "December revenue", sql: "SELECT 1" }, invocation);
    expect(output).toMatchObject({ kind: "continue", artifact: { delivery: "visible", input: { declaredScope: { intent: "December revenue" } } } });
    expect(invocation.checkContinuation).toHaveBeenCalledOnce();
    expect(invocation.applicationContext.visibleEvidence.size).toBe(0);
  });

  it("persists oversized evidence without supplying rows and exactly replays feedback", async () => {
    const result = evidence();
    const invocation = toolInvocation();
    invocation.checkContinuation = vi.fn().mockImplementationOnce(() => { throw new ContextError("context_limit", "Full payload too large"); });
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: result }));
    const output = await tool("run_sql", execute).execute({ intent: "December revenue", sql: "SELECT 1" }, invocation);
    expect(output).toMatchObject({ kind: "error", repeatPolicy: "unchanged_arguments", artifact: { delivery: "unavailable" } });
    expect(invocation.checkContinuation).toHaveBeenCalledTimes(2);
    if (output.kind !== "error") throw new Error("Expected feedback");
    const feedback = { ok: false, error: output.error };
    expect(projectUnavailableEvidence(result.resultId, feedback)).toEqual(feedback);
    expect(JSON.stringify(feedback)).not.toContain("160555");
    expect(output.artifact?.input.evidence.rows).toEqual(result.rows);
  });

  it("does not swallow protocol preflight failures or a compact-feedback overflow", async () => {
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: evidence() }));
    for (const code of ["replay_mismatch", "context_limit"] as const) {
      const invocation = toolInvocation();
      invocation.checkContinuation = () => { throw new ContextError(code, "No space or invalid replay"); };
      await expect(tool("run_sql", execute).execute({ intent: "Revenue", sql: "SELECT 1" }, invocation)).rejects.toMatchObject({ code });
    }
  });

  it("rejects semantic version mismatches", async () => {
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: evidence({ semanticGuideVersion: "other" }) }));
    await expect(tool("run_sql", execute).execute({ intent: "Revenue", sql: "SELECT 1" }, toolInvocation())).rejects.toMatchObject({ code: "internal" });
  });

  it("hides SQL when attempts or result bytes are exhausted", () => {
    const invocation = toolInvocation();
    const state = invocation.applicationContext;
    const sqlTool = tool("run_sql");
    state.queryExecution.budget.attemptsUsed = 4;
    expect(sqlTool.isAvailable?.(state)).toBe(false);
    state.queryExecution.budget.attemptsUsed = 0;
    state.queryExecution.budget.resultBytesUsed = state.queryExecution.budget.maxResultBytes;
    expect(sqlTool.isAvailable?.(state)).toBe(false);
  });

  it("permits explanation and focused clarification without a warehouse call", async () => {
    expect(await tool("finish_answer").execute(answer([], { basis: "explanation", narrative: "A session groups a user's recorded interactions." }), toolInvocation()))
      .toMatchObject({ kind: "terminal", outcome: { kind: "answer" } });
    expect(await tool("request_clarification").execute({ question: "Which period?", choices: ["November", "December"] }, toolInvocation()))
      .toMatchObject({ kind: "terminal", outcome: { kind: "clarification" } });
  });

  it("requires visible evidence for data answers and partial completeness for service truncation", async () => {
    const finish = tool("finish_answer");
    expect(await finish.execute(answer(), toolInvocation())).toMatchObject({ kind: "error", error: { code: "missing_evidence" } });
    expect(await finish.execute(answer([randomUUID()]), toolInvocation())).toMatchObject({ kind: "error", error: { code: "invalid_evidence" } });
    const input = savedEvidence(evidence({ truncated: true, truncationReason: "row_limit" }));
    const invocation = toolInvocation(new Map([[input.evidence.resultId, input]]));
    expect(await finish.execute(answer([input.evidence.resultId]), invocation)).toMatchObject({ kind: "error", error: { code: "incomplete_evidence" } });
    expect(await finish.execute(answer([input.evidence.resultId], { completeness: "partial", limitations: ["Service returned only a prefix of rows."] }), invocation))
      .toMatchObject({ kind: "terminal", outcome: { answer: { completeness: "partial" } } });
  });

  it("rejects an invalid chart before terminal acceptance and accepts a text repair", async () => {
    const input = savedEvidence();
    const invocation = toolInvocation(new Map([[input.evidence.resultId, input]]));
    const finish = tool("finish_answer");
    const invalidChart = {
      type: "bar", evidenceId: input.evidence.resultId, title: "Revenue", caption: "Revenue by category.",
      x: { column: "missing_category", label: "Category" },
      series: [{ column: "revenue_usd", label: "Revenue", format: { kind: "currency", currency: "USD" } }],
    };
    expect(await finish.execute(answer([input.evidence.resultId], { charts: [invalidChart] }), invocation))
      .toMatchObject({ kind: "error", error: { code: "invalid_chart", details: { chartIndex: 0 } }, repeatPolicy: "unchanged_arguments" });
    expect(await finish.execute(answer([input.evidence.resultId]), invocation)).toMatchObject({ kind: "terminal" });
    expect(await finish.execute({ ...answer([input.evidence.resultId]), charts: undefined }, invocation))
      .toMatchObject({ kind: "error", error: { code: "invalid_arguments" } });
  });
});

describe("analysis service", () => {
  it("repairs an early finish, checkpoints intent/evidence, then accepts the identical answer", async () => {
    const result = evidence();
    const checkpoints: AnalysisCheckpoint[] = [];
    const finish = answer([result.resultId]);
    const model = modelSequence(
      () => action("finish_answer", finish),
      () => action("run_sql", { intent: "December revenue in USD", sql: "SELECT 1" }),
      request => {
        expect(checkpoints.map(event => event.kind)).toEqual(["assistant", "tool_result", "assistant", "tool_result"]);
        expect(JSON.stringify(request.messages)).toContain('"intent":"December revenue in USD"');
        return action("finish_answer", finish);
      },
    );
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: result }));
    const output = await analyzeWith(model, execute)(runInput({ checkpoint: async event => { checkpoints.push(event); } }));
    expect(output).toMatchObject({ kind: "terminal", outcome: { kind: "answer", answer: { evidenceIds: [result.resultId] } } });
    expect(checkpoints.at(-1)?.kind).toBe("terminal");
  });

  it("does not continue or accept evidence after a failed checkpoint", async () => {
    const complete = vi.fn(async () => action("run_sql", { intent: "Revenue", sql: "SELECT 1" }));
    const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: evidence() }));
    const output = await analyzeWith({ complete }, execute)(runInput({ checkpoint: async event => {
      if (event.kind === "tool_result") throw new Error("Persistence unavailable");
    } }));
    expect(output).toMatchObject({ kind: "failure", error: { code: "persistence" } });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("seeds historical evidence only when owned and fully present in context", async () => {
    const stored = savedEvidence();
    const input = runInput({
      storedEvidence: [stored], context: { includedEvidenceIds: [stored.evidence.resultId], messages: [
        { role: "assistant", content: null, toolCalls: [{ callId: "old", name: "run_sql", argumentsJson: "{}" }] },
        { role: "tool", callId: "old", content: projectEvidence(stored) }, { role: "user", content: "And that result?" },
      ] },
    });
    const execute: QueryExecutor = vi.fn<QueryExecutor>();
    const model = modelSequence(() => action("finish_answer", answer([stored.evidence.resultId])));
    expect(await analyzeWith(model, execute)(input)).toMatchObject({ kind: "terminal" });
    expect(execute).not.toHaveBeenCalled();
    await expect(analyzeWith(model, execute)({ ...input, storedEvidence: [{ ...stored, conversationId: randomUUID() }] })).rejects.toMatchObject({ code: "invalid_history" });
    await expect(analyzeWith(model, execute)({ ...input, context: { ...input.context, messages: [{ role: "user", content: "Question" }] } })).rejects.toMatchObject({ code: "missing_evidence" });
  });

  it("retains unavailable evidence across SQLite reopening without granting visibility", async () => {
    const directory = mkdtempSync(join(tmpdir(), "analysis-context-"));
    directories.push(directory);
    const databasePath = join(directory, "test.sqlite");
    let repository = openConversationRepository({ databasePath });
    try {
      const conversation = await repository.createConversation();
      const versions = { model: "test", prompt: "analyst-v2", tools: "analysis-tools-v2", semanticGuide: SEMANTIC_GUIDE_VERSION };
      const initialHistory = await repository.loadHistory(conversation.id);
      const { run } = await repository.startRun({ conversationId: conversation.id, message: "Revenue?", clientMessageId: randomUUID(), deadline: Date.now() + 10_000, versions, expectedRevision: projectConversation(initialHistory).revision });
      const query = evidence();
      const model = modelSequence(
        () => action("run_sql", { intent: "Revenue in USD", sql: "SELECT 1" }),
        () => action("finish_answer", answer([query.resultId])),
        () => action("request_clarification", { question: "Can we narrow this request?" }),
      );
      const execute: QueryExecutor = vi.fn<QueryExecutor>(async () => ({ ok: true, evidence: query }));
      const output = await analyzeWith(model, execute, request => {
        if (request.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes('"rows"'))) {
          throw new ContextError("context_limit", "Full result does not fit");
        }
      })(runInput({ conversationId: conversation.id, checkpoint: async event => {
        if (event.kind === "assistant") await repository.appendAssistant(run.id, event.response.message);
        if (event.kind === "tool_result") {
          const artifact = event.artifact;
          await repository.recordToolResult(run.id, { callId: event.callId, payload: artifact
            ? { kind: "evidence_unavailable", evidenceId: artifact.input.evidence.resultId, content: event.content }
            : { kind: "inline", content: event.content } }, artifact?.input);
        }
        if (event.kind === "terminal") await repository.finishRun(run.id, { outcome: event.outcome,
          acknowledgment: { callId: event.callId, payload: { kind: "inline", content: event.acknowledgment } } });
      } }));
      expect(output).toMatchObject({ kind: "terminal", outcome: { kind: "clarification" } });
      repository.close();
      repository = openConversationRepository({ databasePath });
      const followUpHistory = await repository.loadHistory(conversation.id);
      const { run: next } = await repository.startRun({ conversationId: conversation.id, message: "Mobile only", clientMessageId: randomUUID(), deadline: Date.now() + 10_000, versions, expectedRevision: projectConversation(followUpHistory).revision });
      const history = await repository.loadHistory(conversation.id);
      const built = createContextBuilder({ measurer: { measure: () => ({ requestBytes: 1, estimatedInputTokens: 1, estimator: "fixture" }) }, budget: { contextWindowTokens: 65_536, safetyTokens: 2048 } })({
        history, targetRunId: next.id, instructions: buildAnalystInstructions(), requestSettings: { tools: ANALYSIS_TOOL_DESCRIPTIONS,
          toolSelection: { kind: "required" }, maxOutputTokens: 4096, signal: new AbortController().signal, deadline: next.deadline },
      });
      expect(built.includedEvidenceIds).toEqual([]);
      expect(history.evidence[0].declaredScope).toEqual({ intent: "Revenue in USD" });
      expect(JSON.stringify(built.messages)).toContain("result_too_large_for_context");
      expect(JSON.stringify(built.messages)).not.toContain('"revenue_usd":160555');
      expect(history.evidence[0].evidence.rows).toEqual(query.rows);
    } finally {
      repository.close();
    }
  });
});
