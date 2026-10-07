import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConversationRepository } from "../adapters/persistence/repository";
import { projectConversation } from "../conversations/display";
import { listDebugRuns, readDebugRun } from "./agent-traces";
import { debugRunSchema } from "../../shared/agent-debug";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hockeystack-debug-"));
  directories.push(directory);
  const databasePath = join(directory, "history.sqlite");
  vi.stubEnv("SQLITE_DATABASE_PATH", databasePath);
  vi.stubEnv("NODE_ENV", "test");
  const repository = openConversationRepository({ databasePath });
  try {
    const conversation = await repository.createConversation();
    const { run } = await repository.startRun({
      conversationId: conversation.id, clientMessageId: randomUUID(), message: "Test question",
      expectedRevision: projectConversation(await repository.loadHistory(conversation.id)).revision,
      deadline: Date.now() + 1000,
      versions: { model: "test", prompt: "test", tools: "test", semanticGuide: "test" },
    });
    await repository.finishRun(run.id, { outcome: { kind: "failure", status: "failed", error: { code: "provider", message: "Unavailable" } } });
    // Capturing a trace after the outcome is durable must not alter that outcome.
    await repository.recordAgentTrace(run.id, {
      kind: "tool_call", payload: { diagnostic: ["arbitrary", 123] }, startedAt: 1, finishedAt: 2,
    });
    return { databasePath, runId: run.id };
  } finally {
    repository.close();
  }
}

describe("local debugger read boundary", () => {
  it("reads typed envelopes and arbitrary payloads without changing terminal outcomes", async () => {
    const f = await fixture();
    expect(listDebugRuns()[0]).toMatchObject({ id: f.runId, status: "failed" });
    const detail = readDebugRun(f.runId);
    expect(debugRunSchema.safeParse(detail).success).toBe(true);
    expect(detail?.traces[0].payload).toEqual({ diagnostic: ["arbitrary", 123] });
    expect(detail?.run.status).toBe("failed");
    expect(detail?.contextCapture).toContain("no exact provider request bodies");
    expect(readDebugRun(randomUUID())).toBeNull();
  });

  it("preserves malformed JSON for inspection and rejects malformed SQL row envelopes", async () => {
    const f = await fixture();
    const database = new Database(f.databasePath);
    try {
      database.prepare("UPDATE agent_traces SET payload_json = ? WHERE run_id = ?").run("{broken", f.runId);
      expect(readDebugRun(f.runId)?.traces[0].payload).toEqual({ invalidJson: true, raw: "{broken" });
      database.prepare("UPDATE agent_traces SET started_at = ? WHERE run_id = ?").run("invalid", f.runId);
      expect(() => readDebugRun(f.runId)).toThrow();
    } finally {
      database.close();
    }
  });

  it("disables the reader in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => listDebugRuns()).toThrow("not_available");
  });
});
