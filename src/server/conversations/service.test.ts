import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModel, ModelResponse } from "../agent/contracts";
import { createAgentRunner } from "../agent/runner";
import { ModelError } from "../agent/errors";
import { createAnalysisService } from "../analysis/service";
import { ANALYSIS_TOOL_DESCRIPTIONS } from "../analysis/contracts";
import { analysisMetadataFixture } from "../analysis/analysis.fixtures";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { createOpenRouterAgentModel } from "../adapters/openrouter/agent-model";
import { openConversationRepository } from "../adapters/persistence/repository";
import { createContextBuilder } from "../context/builder";
import { ContextError } from "../context/contracts";
import { createQueryService } from "../data/query-service";
import { SEMANTIC_GUIDE_VERSION } from "../data/semantic-guide";
import { REFERENCE_QUERIES } from "../data/reference-queries";
import type { ChatStreamEvent } from "../../shared/conversations";
import { ConversationRepositoryError, type ConversationRepository } from "./repository";
import { createConversationService, type AdmittedSubmission, type PreparedConversationExecution } from "./service";

const repositories: ConversationRepository[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function action(name: string, argumentsValue: unknown): ModelResponse {
  return {
    finishReason: "tool_calls",
    message: {
      role: "assistant", content: "Intermediate text must stay private",
      toolCalls: [{ callId: randomUUID(), name, argumentsJson: JSON.stringify(argumentsValue) }],
      providerReplay: { origin: { model: "test/model" }, reasoning: "private reasoning" },
    },
  };
}

function answer(evidenceIds: string[] = []) {
  return {
    basis: evidenceIds.length > 0 ? "data" : "explanation",
    analysis: analysisMetadataFixture(evidenceIds),
    narrative: "A supported answer.", assumptions: [], limitations: [], evidenceIds, completeness: "complete", charts: [],
  };
}

function prepared(model: AgentModel): PreparedConversationExecution {
  const measurer = createOpenRouterRequestMeasurer("test/model");
  const query = createQueryService({
    maximumBytesBilled: "1000",
    gateway: {
      async dryRun() { return { estimatedBytes: "100" }; },
      async submit() {
        return {
          id: "test-job",
          async readPage() {
            return {
              complete: true,
              columns: [
                { name: "category", type: "STRING" },
                { name: "revenue_usd", type: "FLOAT" },
                { name: "private_column", type: "STRING" },
              ],
              rows: [{ category: "Mobile", revenue_usd: 12.5, private_column: "unselected value" }],
            };
          },
          async statistics() { return { bytesProcessed: "100", bytesBilled: "100", cacheHit: false }; },
          async cancel() {},
        };
      },
    },
  });
  return {
    versions: { model: "test/model", prompt: "test-prompt", tools: "test-tools", semanticGuide: SEMANTIC_GUIDE_VERSION },
    instructions: ["Analyst instructions"],
    tools: ANALYSIS_TOOL_DESCRIPTIONS,
    buildContext: createContextBuilder({ measurer, budget: { contextWindowTokens: 65_536, safetyTokens: 2_048 } }),
    analyze: createAnalysisService({ runAgent: createAgentRunner({ model, preflight() {} }), executeQuery: query }),
  };
}

async function fixture(complete: AgentModel["complete"] = async () => action("finish_answer", answer())) {
  const directory = mkdtempSync(join(tmpdir(), "hockeystack-conversation-"));
  directories.push(directory);
  const databasePath = join(directory, "conversation.sqlite");
  let clock = Date.now();
  function open() {
    const repository = openConversationRepository({ databasePath, now: () => clock });
    repositories.push(repository);
    return repository;
  }
  const repository = open();
  const model = { complete: vi.fn(complete) };
  const preparation = vi.fn(() => prepared(model));
  function serviceFor(storage = repository) {
    return createConversationService({ repository: storage, prepareExecution: preparation, now: () => clock });
  }
  const service = serviceFor();
  const initial = await service.create();
  const input = { message: "Revenue?", clientMessageId: randomUUID(), expectedRevision: initial.revision };
  return { repository, service, initial, input, model, preparation, serviceFor, open, setTime: (value: number) => { clock = value; } };
}

async function execute(admitted: AdmittedSubmission, signal = new AbortController().signal): Promise<ChatStreamEvent[]> {
  if (!admitted.execute) {
    throw new Error("Expected a new attempt");
  }
  const events: ChatStreamEvent[] = [];
  await admitted.execute(signal, event => events.push(event));
  return events;
}

describe("conversation application workflow", () => {
  it("finalizes a failed context even when diagnostic reporting throws", async () => {
    const f = await fixture();
    const service = createConversationService({
      repository: f.repository,
      prepareExecution: () => ({
        ...prepared(f.model),
        buildContext() { throw new ContextError("context_limit", "Oversized context"); },
      }),
      reportFailure() { throw new Error("diagnostic sink unavailable"); },
    });
    const admitted = await service.submitMessage(f.initial.conversationId, f.input);
    const events = await execute(admitted);
    expect(events.at(-1)).toMatchObject({ kind: "error" });
    expect((await f.repository.loadHistory(f.initial.conversationId)).runs[0]).toMatchObject({
      status: "failed", outcome: { kind: "failure", error: { code: "context_limit" } },
    });
  });

  it("accepts and persists answers even when all debug trace writes fail", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "recordAgentTrace").mockRejectedValue(new Error("debug storage unavailable"));
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "answer" });
    expect((await f.repository.loadHistory(f.initial.conversationId)).runs[0].status).toBe("completed");
  });

  it("persists provider usage without optional fields and records tool traces after acceptance", async () => {
    const provider = createOpenRouterAgentModel({ apiKey: "fake-key", model: "test/model" }, async () => Response.json({
      model: "test/model",
      choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "finish-1", type: "function", function: { name: "finish_answer", arguments: JSON.stringify(answer()) } }],
      } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }));
    const f = await fixture(provider.complete);
    const record = vi.spyOn(f.repository, "recordAgentTrace");
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "answer" });
    expect(record.mock.calls.map(([, trace]) => trace.kind)).toEqual(["model_call", "tool_call"]);
    expect(record.mock.calls[0][1].payload).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3 } });
    expect((await f.repository.loadHistory(f.initial.conversationId)).runs[0].status).toBe("completed");
  });

  it("persists a final answer before publishing, survives reopen, and excludes protocol data", async () => {
    const f = await fixture();
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    const events = await execute(admitted);
    expect(events.at(-1)).toMatchObject({ kind: "answer", snapshot: { turns: [{ content: "Revenue?", attempts: [{ status: "completed" }] }] } });
    const history = await f.repository.loadHistory(f.initial.conversationId);
    expect(history.events.map(event => event.payload.kind)).toEqual(["user_message", "assistant_message", "tool_result", "outcome"]);
    f.repository.close();
    const snapshot = await f.serviceFor(f.open()).load(f.initial.conversationId);
    expect(snapshot.turns[0].attempts[0].outcome).toMatchObject({ kind: "answer" });
    const encoded = JSON.stringify({ snapshot, events });
    expect(encoded).not.toContain("private reasoning");
    expect(encoded).not.toContain("Intermediate text");
    expect(encoded).not.toContain("argumentsJson");
  });

  it("records query evidence atomically and supplies it to a follow-up after reopening", async () => {
    const f = await fixture(async request => {
      if (request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "Revenue?") {
        return action("run_sql", { intent: "December purchase revenue in USD", sql: REFERENCE_QUERIES.decemberRevenue });
      }
      const evidenceIds = request.messages.flatMap(message => {
        if (message.role !== "tool" || message.content === null || typeof message.content !== "object" || Array.isArray(message.content)) {
          return [];
        }
        const evidence = message.content.evidence;
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || typeof evidence.resultId !== "string") {
          return [];
        }
        return [evidence.resultId];
      });
      return action("finish_answer", answer(evidenceIds));
    });
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    const events = await execute(admitted);
    expect(events.filter(event => event.kind === "progress").map(event => event.phase)).toEqual(["thinking", "querying", "thinking"]);
    const history = await f.repository.loadHistory(f.initial.conversationId);
    expect(history.evidence).toHaveLength(1);
    const snapshot = await f.service.load(f.initial.conversationId);
    f.repository.close();
    const service = f.serviceFor(f.open());
    const followUp = await service.submitMessage(snapshot.conversationId, { message: "Explain that result", clientMessageId: randomUUID(), expectedRevision: snapshot.revision });
    expect((await execute(followUp)).at(-1)).toMatchObject({ kind: "answer" });
    const call = f.model.complete.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(call?.messages)).toContain(history.evidence[0].evidence.resultId);
    expect(JSON.stringify(await service.load(snapshot.conversationId))).not.toContain("test-job");
  });

  it("projects charts consistently after terminal commit, reload, duplicate submission and follow-up", async () => {
    const f = await fixture(async request => {
      if (request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "Revenue?") {
        return action("run_sql", { intent: "Revenue by category in USD", sql: REFERENCE_QUERIES.decemberRevenue });
      }
      const evidenceIds = request.messages.flatMap(message => {
        if (message.role !== "tool" || message.content === null || typeof message.content !== "object" || Array.isArray(message.content)) {
          return [];
        }
        const evidence = message.content.evidence;
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || typeof evidence.resultId !== "string") {
          return [];
        }
        return [evidence.resultId];
      });
      expect(JSON.stringify(request.messages)).not.toContain("renderedCharts");
      const charts = [{
        type: "bar", evidenceId: evidenceIds[0], title: "Revenue by category", caption: "Mobile revenue in the sample period.",
        x: { column: "category", label: "Category" },
        series: [{ column: "revenue_usd", label: "Revenue", format: { kind: "currency", currency: "USD" } }],
      }];
      return action("finish_answer", { ...answer(evidenceIds), charts });
    });
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    const events = await execute(admitted);
    const terminal = events.at(-1);
    if (!terminal || terminal.kind !== "answer") throw new Error("Expected an accepted answer");
    const snapshot = terminal.snapshot;
    expect(snapshot.turns[0].attempts[0].renderedCharts?.[0]).toMatchObject({
      kind: "ready", rows: [{ category: "Mobile", revenue_usd: 12.5 }],
    });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("unselected value");
    expect(encoded).not.toContain("private_column");
    expect(encoded).not.toContain("SELECT");
    const history = await f.repository.loadHistory(snapshot.conversationId);
    expect(JSON.stringify(history.runs[0].outcome)).not.toContain("renderedCharts");
    expect(JSON.stringify(history.events)).not.toContain('"kind":"ready"');
    expect(history.evidence[0].evidence.rows[0].private_column).toBe("unselected value");

    f.repository.close();
    const service = f.serviceFor(f.open());
    expect(await service.load(snapshot.conversationId)).toEqual(snapshot);
    expect((await service.submitMessage(snapshot.conversationId, f.input)).snapshot).toEqual(snapshot);
    const followUp = await service.submitMessage(snapshot.conversationId, {
      message: "Explain that comparison", clientMessageId: randomUUID(), expectedRevision: snapshot.revision,
    });
    expect((await execute(followUp)).at(-1)?.kind).toBe("answer");
    expect(JSON.stringify(f.model.complete.mock.calls.at(-1)?.[0].messages)).not.toContain("renderedCharts");
  });

  it("ends clarification and reconstructs its question and choices for the next message", async () => {
    const f = await fixture(async request => {
      if (request.messages.filter(message => message.role === "user").length === 1) {
        return action("request_clarification", { question: "Which month?", choices: ["November", "December"] });
      }
      expect(JSON.stringify(request.messages)).toContain("Which month?");
      expect(request.messages.at(-1)).toEqual({ role: "user", content: "December" });
      return action("finish_answer", answer());
    });
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "clarification" });
    const snapshot = await f.service.load(f.initial.conversationId);
    const reply = await f.service.submitMessage(snapshot.conversationId, { message: "December", clientMessageId: randomUUID(), expectedRevision: snapshot.revision });
    expect((await execute(reply)).at(-1)).toMatchObject({ kind: "answer" });
  });

  it("admits concurrent matching submissions once across database connections", async () => {
    const f = await fixture();
    const second = f.serviceFor(f.open());
    const submissions = await Promise.all([
      f.service.submitMessage(f.initial.conversationId, f.input),
      second.submitMessage(f.initial.conversationId, f.input),
    ]);
    expect(submissions.map(item => item.created).sort()).toEqual([false, true]);
    expect(new Set(submissions.map(item => item.run.id)).size).toBe(1);
    for (const submission of submissions) {
      if (submission.created) {
        await execute(submission);
      }
    }
    expect(f.model.complete).toHaveBeenCalledTimes(1);
  });

  it("returns completed duplicates despite stale revision and unavailable analytical configuration", async () => {
    const f = await fixture();
    await execute(await f.service.submitMessage(f.initial.conversationId, f.input));
    f.preparation.mockImplementation(() => { throw new Error("Unavailable credentials"); });
    const duplicate = await f.service.submitMessage(f.initial.conversationId, f.input);
    expect(duplicate).toMatchObject({ created: false, run: { status: "completed" } });
    expect(duplicate.execute).toBeUndefined();
    expect(f.preparation).toHaveBeenCalledTimes(1);
    await expect(f.service.submitMessage(f.initial.conversationId, { ...f.input, message: "Different" })).rejects.toMatchObject({ conflictReason: "submission_mismatch" });
  });

  it("rejects stale new messages and allows a reviewed message at the current revision", async () => {
    const f = await fixture();
    await execute(await f.service.submitMessage(f.initial.conversationId, f.input));
    await expect(f.service.submitMessage(f.initial.conversationId, { ...f.input, clientMessageId: randomUUID() })).rejects.toMatchObject({ conflictReason: "stale_revision" });
    const latest = await f.service.load(f.initial.conversationId);
    const followUp = await f.service.submitMessage(latest.conversationId, { message: "Mobile only", clientMessageId: randomUUID(), expectedRevision: latest.revision });
    await expect(f.service.submitMessage(latest.conversationId, { message: "Another", clientMessageId: randomUUID(), expectedRevision: followUp.snapshot.revision })).rejects.toMatchObject({ conflictReason: "active_run" });
  });

  it("links a retry without duplicating its question, and changes revision before retry events exist", async () => {
    const f = await fixture(async () => { throw new ModelError("provider", "private provider detail"); });
    const original = await f.service.submitMessage(f.initial.conversationId, f.input);
    await execute(original);
    const snapshot = await f.service.load(f.initial.conversationId);
    const retryInput = { clientMessageId: randomUUID(), expectedRevision: snapshot.revision };
    const retry = await f.service.retry(snapshot.conversationId, original.run.id, retryInput);
    expect(retry.run.retryOfRunId).toBe(original.run.id);
    expect(retry.snapshot.turns).toHaveLength(1);
    expect(retry.snapshot.turns[0].attempts).toHaveLength(2);
    expect(retry.snapshot.revision).not.toBe(snapshot.revision);
    expect(await f.service.retry(snapshot.conversationId, original.run.id, retryInput)).toMatchObject({ created: false });
    await execute(retry);
    const later = await f.service.load(snapshot.conversationId);
    await expect(f.service.retry(snapshot.conversationId, original.run.id, { clientMessageId: randomUUID(), expectedRevision: later.revision })).rejects.toMatchObject({ conflictReason: "invalid_retry" });
    expect(JSON.stringify(later)).not.toContain("private provider detail");
  });

  it("records cancellation and retains an unanswered question", async () => {
    const f = await fixture();
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    const controller = new AbortController();
    controller.abort();
    expect((await execute(admitted, controller.signal)).at(-1)).toMatchObject({ kind: "error", snapshot: { turns: [{ attempts: [{ status: "cancelled" }] }] } });
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("preserves an answer when cancellation arrives during terminal persistence", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const repository: ConversationRepository = {
      ...f.repository,
      async finishRun(runId, input) {
        if (input.outcome.kind === "answer") {
          controller.abort();
        }
        return f.repository.finishRun(runId, input);
      },
    };
    const admitted = await f.serviceFor(repository).submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted, controller.signal)).at(-1)).toMatchObject({ kind: "answer" });
  });

  it("stops after a failed assistant checkpoint and records a persistence failure", async () => {
    const f = await fixture();
    const repository: ConversationRepository = {
      ...f.repository,
      async appendAssistant() { throw new ConversationRepositoryError("unavailable", "private DB detail"); },
    };
    const admitted = await f.serviceFor(repository).submitMessage(f.initial.conversationId, f.input);
    const events = await execute(admitted);
    expect(events.at(-1)).toMatchObject({ kind: "error", snapshot: { turns: [{ attempts: [{ outcome: { error: { code: "persistence" } } }] }] } });
    expect(f.model.complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain("private DB detail");
  });

  it("reports uncertainty when the terminal outcome cannot be persisted", async () => {
    const f = await fixture();
    const repository: ConversationRepository = {
      ...f.repository,
      async finishRun() { throw new ConversationRepositoryError("unavailable", "database offline"); },
    };
    const admitted = await f.serviceFor(repository).submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "error", error: { code: "synchronization_failed" } });
    expect((await f.repository.loadHistory(f.initial.conversationId)).runs[0].status).toBe("running");
  });

  it("honors expiry grace, interrupts abandoned attempts, and never restarts duplicate execution", async () => {
    const f = await fixture();
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    f.setTime(admitted.run.deadline + 4_999);
    expect((await f.service.load(f.initial.conversationId)).turns[0].attempts[0].status).toBe("running");
    f.setTime(admitted.run.deadline + 5_000);
    expect((await f.service.load(f.initial.conversationId)).turns[0].attempts[0].status).toBe("interrupted");
    expect(await f.service.submitMessage(f.initial.conversationId, f.input)).toMatchObject({ created: false, run: { status: "interrupted" } });
    expect(f.model.complete).not.toHaveBeenCalled();
    await expect(f.repository.appendContextNote(admitted.run.id, "late result")).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns reconciliation's committed interruption when it wins terminal persistence", async () => {
    const f = await fixture();
    let deadline = 0;
    const repository: ConversationRepository = {
      ...f.repository,
      async finishRun(runId, input) {
        if (input.outcome.kind === "answer") {
          await f.repository.interruptExpiredRuns(deadline + 5_000, 5_000);
        }
        return f.repository.finishRun(runId, input);
      },
    };
    const admitted = await f.serviceFor(repository).submitMessage(f.initial.conversationId, f.input);
    deadline = admitted.run.deadline;
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "error", snapshot: { turns: [{ attempts: [{ status: "interrupted" }] }] } });
  });

  it("records initial context overflow before any model execution", async () => {
    const f = await fixture();
    f.preparation.mockImplementation(() => ({ ...prepared(f.model), buildContext() { throw new ContextError("context_limit", "Too large"); } }));
    const admitted = await f.service.submitMessage(f.initial.conversationId, f.input);
    expect((await execute(admitted)).at(-1)).toMatchObject({ kind: "error", snapshot: { turns: [{ attempts: [{ outcome: { error: { code: "context_limit" } } }] }] } });
    expect(f.model.complete).not.toHaveBeenCalled();
  });
});
