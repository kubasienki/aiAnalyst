import { projectConversation } from "../../conversations/display";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../agent/contracts";
import type { EvidenceInput, RunOutcome, StoredToolResult } from "../../conversations/contracts";
import type { ConversationRepository } from "../../conversations/repository";
import { openConversationRepository } from "./repository";

const versions = { model: "test-model", prompt: "analyst-v1", tools: "tools-v1", semanticGuide: "ga4-sample-v1" };
const repositories: ConversationRepository[] = [];
const directories: string[] = [];
const observers: Database.Database[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "analyst-history-"));
  directories.push(directory);
  const databasePath = join(directory, "nested", "history.sqlite");
  let timestamp = 1_000;
  function open() {
    const repository = openConversationRepository({ databasePath, now: () => timestamp });
    repositories.push(repository);
    return repository;
  }
  return { databasePath, open, repository: open(), setTime: (value: number) => { timestamp = value; } };
}

function call(callId: string, name = "run_sql", argumentsJson = "{malformed"): AssistantMessage {
  return { role: "assistant", content: null, toolCalls: [{ callId, name, argumentsJson }] };
}

function evidenceFixture(): EvidenceInput {
  const columns = [{ name: "value", type: "STRING" }];
  const rows = [{ value: "9007199254740993", missing: null, label: "x".repeat(40_000) }];
  return {
    evidence: {
      resultId: randomUUID(), sql: "SELECT value FROM example", columns, rows,
      payloadBytes: Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8"),
      truncated: true, truncationReason: "row_limit", jobId: "job-1", estimatedBytes: "1000",
      statistics: { bytesProcessed: "900", bytesBilled: "1000", cacheHit: false },
      elapsedMs: 35, semanticGuideVersion: "ga4-sample-v1",
    },
    semanticGuideSnapshot: "Revenue uses event-level USD purchase revenue.",
    declaredScope: { period: "December 2020", units: "USD" },
    assumptions: ["Purchase events, not deduplicated orders."],
  };
}

async function start(repository: ConversationRepository, conversationId?: string) {
  const conversation = conversationId ? await repository.getConversation(conversationId) : await repository.createConversation();
  const input = { conversationId: conversation.id, clientMessageId: randomUUID(), message: "December revenue?", deadline: 2_000, versions, expectedRevision: projectConversation(await repository.loadHistory(conversation.id)).revision };
  const { run } = await repository.startRun(input);
  return { conversation, input, run };
}

function acknowledgment(callId: string): StoredToolResult {
  return { callId, payload: { kind: "inline", content: { accepted: true } } };
}

const failure: RunOutcome = { kind: "failure", status: "failed", error: { code: "provider", message: "Provider unavailable." } };

afterEach(() => {
  for (const observer of observers.splice(0)) observer.close();
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite conversation repository", () => {
  it("rejects intervening assistant messages and notes atomically until every batch result is saved", async () => {
    const { repository } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, {
      role: "assistant", content: null,
      toolCalls: [...call("first").toolCalls, ...call("second").toolCalls],
    });
    const before = await repository.loadHistory(conversation.id);
    await expect(repository.appendAssistant(run.id, call("third"))).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.appendContextNote(run.id, "Do something else")).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.loadHistory(conversation.id)).toEqual(before);
    await repository.recordToolResult(run.id, acknowledgment("second"));
    await expect(repository.appendAssistant(run.id, call("third"))).rejects.toMatchObject({ code: "conflict" });
    await repository.recordToolResult(run.id, acknowledgment("first"));
    await repository.appendContextNote(run.id, "The batch is complete.");
    await repository.appendAssistant(run.id, call("third"));
    await repository.finishRun(run.id, { outcome: failure });
    expect((await repository.loadHistory(conversation.id)).runs[0].status).toBe("failed");
  });

  it("persists ordered model and tool traces separately from conversation events", async () => {
    const { repository, databasePath } = fixture();
    const { conversation, run } = await start(repository);
    await repository.recordAgentTrace(run.id, {
      kind: "model_call",
      payload: { requestBody: { messages: [{ role: "user", content: "question" }] }, responseBody: "raw", usage: { inputTokens: 10, outputTokens: 3 } },
      startedAt: 1_100,
      finishedAt: 1_250,
    });
    await repository.recordAgentTrace(run.id, {
      kind: "tool_call",
      payload: { name: "run_sql", argumentsValue: { sql: "SELECT 1" }, result: { kind: "continue" } },
      startedAt: 1_260,
      finishedAt: 1_400,
    });

    const observer = new Database(databasePath, { readonly: true });
    observers.push(observer);
    const traces = observer.prepare("SELECT sequence, kind, payload_json AS payloadJson FROM agent_traces WHERE run_id = ? ORDER BY sequence").all(run.id);
    const history = await repository.loadHistory(conversation.id);

    expect(traces).toEqual([
      { sequence: 1, kind: "model_call", payloadJson: JSON.stringify({ requestBody: { messages: [{ role: "user", content: "question" }] }, responseBody: "raw", usage: { inputTokens: 10, outputTokens: 3 } }) },
      { sequence: 2, kind: "tool_call", payloadJson: JSON.stringify({ name: "run_sql", argumentsValue: { sql: "SELECT 1" }, result: { kind: "continue" } }) },
    ]);
    expect(history.events).toHaveLength(1);
  });

  it("reads a committed snapshot while another connection holds the write reservation", async () => {
    const { repository, databasePath } = fixture();
    const { conversation } = await start(repository);
    const observer = new Database(databasePath);
    observers.push(observer);
    observer.exec("BEGIN IMMEDIATE");
    try {
      observer.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(1_500, conversation.id);
      const history = await repository.loadHistory(conversation.id);
      expect(history.conversation.updatedAt).toBe(1_000);
      expect(history.events).toHaveLength(1);
    } finally {
      observer.exec("ROLLBACK");
    }
  });

  it("reopens a full query/answer exchange without changing evidence or event order", async () => {
    const { repository, open } = fixture();
    const { conversation, run } = await start(repository);
    const evidence = evidenceFixture();
    await repository.appendAssistant(run.id, call("query"));
    await repository.recordToolResult(run.id, { callId: "query", payload: { kind: "evidence", evidenceId: evidence.evidence.resultId } }, evidence);
    await repository.appendAssistant(run.id, call("answer", "finish_answer", "{}"));
    const outcome: RunOutcome = {
      kind: "answer", answer: { narrative: "Supported result.", assumptions: [], limitations: ["Top rows only."], evidenceIds: [evidence.evidence.resultId], completeness: "partial" },
    };
    await repository.finishRun(run.id, { outcome, acknowledgment: acknowledgment("answer") });
    const before = await repository.loadHistory(conversation.id);
    repository.close();
    const reopened = open();
    expect(await reopened.loadHistory(conversation.id)).toEqual(before);
    expect(before.events.map(event => event.payload.kind)).toEqual(["user_message", "assistant_message", "tool_result", "assistant_message", "tool_result", "outcome"]);
    expect(before.events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(before.runs[0]).toMatchObject({ status: "completed", outcome });
    expect(before.evidence[0].evidence).toEqual(evidence.evidence);
    expect(JSON.stringify(before.events)).not.toContain("x".repeat(100));
    expect(before.runs[0].userMessageEventId).toBe(before.events[0].id);
  });

  it("preserves clarification and accepts a new contextual reply after reopening", async () => {
    const { repository, open } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, call("clarify", "request_clarification", '{"question":"Which period?"}'));
    await repository.finishRun(run.id, {
      outcome: { kind: "clarification", clarification: { question: "Which period?", choices: ["November", "December"] } },
      acknowledgment: acknowledgment("clarify"),
    });
    repository.close();
    const reopened = open();
    await reopened.startRun({ conversationId: conversation.id, clientMessageId: randomUUID(), message: "December", deadline: 2_000, versions, expectedRevision: projectConversation(await reopened.loadHistory(conversation.id)).revision });
    const history = await reopened.loadHistory(conversation.id);
    expect(history.runs.map(item => item.status).sort()).toEqual(["running", "waiting_for_user"]);
    expect(history.events.at(-1)?.payload).toEqual({ kind: "user_message", content: "December" });
  });

  it("deduplicates submissions across connections and rejects conflicting input and active runs", async () => {
    const { repository, open } = fixture();
    const { input, run, conversation } = await start(repository);
    const second = open();
    expect(await second.startRun(input)).toEqual({ run, created: false });
    await expect(second.startRun({ ...input, message: "Different question" })).rejects.toMatchObject({ code: "conflict" });
    await expect(second.startRun({ ...input, clientMessageId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    expect((await second.loadHistory(conversation.id)).events).toHaveLength(1);
  });

  it("creates linked retry attempts without duplicating the displayed user message", async () => {
    const { repository } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, call("unfinished"));
    await repository.finishRun(run.id, { outcome: failure });
    const input = { conversationId: conversation.id, runId: run.id, clientMessageId: randomUUID(), deadline: 2_000, versions, expectedRevision: projectConversation(await repository.loadHistory(conversation.id)).revision };
    const retry = await repository.retryRun(input);
    expect(retry.run).toMatchObject({ retryOfRunId: run.id, userMessageEventId: run.userMessageEventId, status: "running" });
    expect(await repository.retryRun(input)).toEqual({ ...retry, created: false });
    expect((await repository.loadHistory(conversation.id)).events.filter(event => event.payload.kind === "user_message")).toHaveLength(1);
    await expect(repository.appendAssistant(run.id, call("late"))).rejects.toMatchObject({ code: "conflict" });
  });

  it("interrupts only expired runs and retains unmatched calls", async () => {
    const { repository, open } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, call("unfinished"));
    repository.close();
    const reopened = open();
    expect(await reopened.interruptExpiredRuns(1_999)).toBe(0);
    expect(await reopened.interruptExpiredRuns(2_000)).toBe(1);
    expect(await reopened.interruptExpiredRuns(2_001)).toBe(0);
    const history = await reopened.loadHistory(conversation.id);
    expect(history.runs[0].status).toBe("interrupted");
    expect(history.events[1].payload).toEqual({ kind: "assistant_message", message: call("unfinished") });
  });

  it("rejects unmatched and duplicate results, duplicate call IDs, and evidence ownership violations", async () => {
    const { repository } = fixture();
    const first = await start(repository);
    await expect(repository.recordToolResult(first.run.id, acknowledgment("missing"))).rejects.toMatchObject({ code: "conflict" });
    await repository.appendAssistant(first.run.id, call("query"));
    await expect(repository.appendAssistant(first.run.id, call("query"))).rejects.toMatchObject({ code: "conflict" });
    const evidence = evidenceFixture();
    const result: StoredToolResult = { callId: "query", payload: { kind: "evidence", evidenceId: evidence.evidence.resultId } };
    await repository.recordToolResult(first.run.id, result, evidence);
    await expect(repository.recordToolResult(first.run.id, result)).rejects.toMatchObject({ code: "conflict" });
    const second = await start(repository);
    await repository.appendAssistant(second.run.id, call("query"));
    await expect(repository.recordToolResult(second.run.id, result)).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.getEvidence(second.conversation.id, evidence.evidence.resultId)).rejects.toMatchObject({ code: "not_found" });
    await expect(repository.retryRun({ conversationId: second.conversation.id, runId: first.run.id, clientMessageId: randomUUID(), deadline: 2_000, versions, expectedRevision: "v1:0:0" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("finalizes atomically and idempotently while rejecting unmatched pending calls", async () => {
    const { repository } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, { role: "assistant", content: "Investigating", toolCalls: [...call("query").toolCalls, ...call("answer", "finish_answer").toolCalls] });
    const input = { outcome: { kind: "answer", answer: { narrative: "Explanation.", assumptions: [], limitations: [], evidenceIds: [], completeness: "complete" } }, acknowledgment: acknowledgment("answer") } satisfies Parameters<ConversationRepository["finishRun"]>[1];
    await expect(repository.finishRun(run.id, input)).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.loadHistory(conversation.id)).events).toHaveLength(2);
    await repository.recordToolResult(run.id, acknowledgment("query"));
    const finished = await repository.finishRun(run.id, input);
    expect(await repository.finishRun(run.id, input)).toEqual(finished);
    await expect(repository.finishRun(run.id, { outcome: failure })).rejects.toMatchObject({ code: "conflict" });
  });

  it("rolls back evidence insertion when saving its result fails", async () => {
    const { repository, databasePath } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, call("query"));
    const observer = new Database(databasePath);
    observers.push(observer);
    observer.exec("CREATE TRIGGER reject_result BEFORE INSERT ON conversation_events WHEN json_extract(NEW.payload_json, '$.kind') = 'tool_result' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    const evidence = evidenceFixture();
    await expect(repository.recordToolResult(run.id, { callId: "query", payload: { kind: "evidence", evidenceId: evidence.evidence.resultId } }, evidence)).rejects.toMatchObject({ code: "unavailable" });
    const history = await repository.loadHistory(conversation.id);
    expect(history.evidence).toEqual([]);
    expect(history.events).toHaveLength(2);
  });

  it("rejects corrupt persisted JSON with an invalid-record error", async () => {
    const { repository, databasePath } = fixture();
    const { conversation } = await start(repository);
    const observer = new Database(databasePath);
    observers.push(observer);
    observer.prepare("UPDATE conversation_events SET payload_json = ?").run('{"kind":"user_message","content":123}');
    await expect(repository.loadHistory(conversation.id)).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("does not upgrade an incompatible existing schema or delete its contents", () => {
    const { repository, databasePath } = fixture();
    repository.close();
    const observer = new Database(databasePath);
    observers.push(observer);
    observer.exec("ALTER TABLE runs RENAME COLUMN versions_json TO legacy_versions");
    expect(() => openConversationRepository({ databasePath })).toThrow("incompatible assessment database");
    expect(observer.prepare("SELECT legacy_versions FROM runs").all()).toEqual([]);
  });

  it("enforces the active-run unique index in SQLite itself", async () => {
    const { repository, databasePath } = fixture();
    const { run } = await start(repository);
    const observer = new Database(databasePath);
    observers.push(observer);
    const duplicate = observer.prepare(`
      INSERT INTO runs (id, conversation_id, user_message_event_id, client_message_id,
        request_json, status, deadline, versions_json, created_at)
      SELECT ?, conversation_id, user_message_event_id, ?, request_json, status,
        deadline, versions_json, created_at FROM runs WHERE id = ?
    `);
    expect(() => duplicate.run(randomUUID(), randomUUID(), run.id)).toThrow("UNIQUE constraint failed: runs.conversation_id");
  });

  it("preserves unavailable evidence references and inline corrective feedback", async () => {
    const { repository, open } = fixture();
    const { conversation, run } = await start(repository);
    await repository.appendAssistant(run.id, call("query"));
    const evidence = evidenceFixture();
    await repository.recordToolResult(run.id, {
      callId: "query",
      payload: { kind: "evidence_unavailable", evidenceId: evidence.evidence.resultId, content: { code: "result_too_large_for_context" } },
    }, evidence);
    await repository.appendAssistant(run.id, call("repair"));
    await repository.recordToolResult(run.id, {
      callId: "repair", payload: { kind: "inline", content: { ok: false, error: { code: "rejected_sql", message: "Narrow the date range." } } },
    });
    const expected = await repository.loadHistory(conversation.id);
    repository.close();
    expect(await open().loadHistory(conversation.id)).toEqual(expected);
  });

  it("rejects invalid input and corrupt run outcomes without rewriting records", async () => {
    const { repository, databasePath } = fixture();
    const { conversation, input, run } = await start(repository);
    await expect(repository.startRun({ ...input, clientMessageId: "not-an-id" })).rejects.toMatchObject({ code: "invalid_input" });
    const observer = new Database(databasePath);
    observers.push(observer);
    observer.prepare("UPDATE runs SET outcome_json = ? WHERE id = ?").run(JSON.stringify(failure), run.id);
    await expect(repository.loadHistory(conversation.id)).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("reopens provider reasoning unchanged with model/provider origin and tool pairing", async () => {
    const { repository, open } = fixture();
    const { conversation, run } = await start(repository);
    const message: AssistantMessage = {
      ...call("query"),
      providerReplay: {
        origin: { model: "actual-model-version", provider: "provider-a", endpoint: "endpoint-a" },
        reasoning: `  ${"Original provider reasoning.\n".repeat(2_000)}  `,
        reasoningDetails: [
          { signature: "signature-1", type: "reasoning.text", text: "Unmodified text.", index: 0 },
          { data: "encrypted-block", type: "reasoning.encrypted", id: "block-2", index: 1, extra: [null, { nested: "value" }] },
        ],
      },
    };
    await repository.appendAssistant(run.id, message);
    await repository.recordToolResult(run.id, acknowledgment("query"));
    await repository.finishRun(run.id, { outcome: failure });
    repository.close();
    const history = await open().loadHistory(conversation.id);
    const assistantEvent = history.events[1];
    expect(assistantEvent.payload.kind).toBe("assistant_message");
    if (assistantEvent.payload.kind !== "assistant_message") {
      throw new Error("Expected the saved assistant message.");
    }
    expect(assistantEvent.payload.message).toEqual(message);
    expect(JSON.stringify(assistantEvent.payload.message.providerReplay?.reasoningDetails))
      .toBe(JSON.stringify(message.providerReplay?.reasoningDetails));
    expect(history.events[2].payload).toEqual({ kind: "tool_result", result: acknowledgment("query") });
    expect(history.evidence).toEqual([]);
  });
});
