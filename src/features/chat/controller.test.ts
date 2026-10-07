import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot, ChatStreamEvent } from "../../shared/conversations";
import { ChatController, canRetry } from "./controller";
import { ChatRequestError, type ChatApi } from "./chat-api";
import type { ChatStorage, PendingOperation } from "./storage";

const controllers: ChatController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  vi.useRealTimers();
});

function empty(): ConversationSnapshot {
  return { conversationId: randomUUID(), revision: "v1:0:0", turns: [] };
}

function running(snapshot: ConversationSnapshot, operation: PendingOperation): ConversationSnapshot {
  return {
    ...snapshot,
    revision: "v1:1:1",
    turns: [{ id: randomUUID(), sequence: 1, content: "Revenue?", attempts: [{
      id: randomUUID(), clientMessageId: operation.clientMessageId, retryOfRunId: null,
      status: "running", deadline: Date.now() + 120_000, outcome: null,
    }] }],
  };
}

function complete(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    ...snapshot,
    revision: "v1:1:4",
    turns: snapshot.turns.map(turn => ({
      ...turn,
      attempts: turn.attempts.map(attempt => ({
        ...attempt,
        status: "completed",
        outcome: { kind: "answer", answer: { narrative: "Answer", assumptions: [], limitations: [], evidenceIds: [], completeness: "complete" } },
      })),
    })),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(initial = empty(), pending: PendingOperation | null = null) {
  let serverSnapshot = initial;
  let activeId: string | null = initial.conversationId;
  let storedPending = pending;
  const storage: ChatStorage = {
    loadActiveId: vi.fn(() => activeId),
    saveActiveId: vi.fn(id => { activeId = id; }),
    loadPending: vi.fn(() => storedPending),
    savePending: vi.fn(operation => { storedPending = operation; }),
    clearPending: vi.fn(() => { storedPending = null; }),
  };
  const api: ChatApi = {
    create: vi.fn(async () => empty()),
    load: vi.fn(async () => serverSnapshot),
    submit: vi.fn(async (operation, _signal, onEvent) => {
      serverSnapshot = running(serverSnapshot, operation);
      onEvent({ kind: "accepted", runId: serverSnapshot.turns[0].attempts[0].id, snapshot: serverSnapshot });
      serverSnapshot = complete(serverSnapshot);
      onEvent({ kind: "answer", runId: serverSnapshot.turns[0].attempts[0].id, snapshot: serverSnapshot });
    }),
  };
  const controller = new ChatController({ api, storage, newId: randomUUID });
  controllers.push(controller);
  return { controller, api, storage, storedPending: () => storedPending, setServer: (value: ConversationSnapshot) => { serverSnapshot = value; } };
}

function pendingMessage(snapshot: ConversationSnapshot): PendingOperation {
  return { kind: "message", conversationId: snapshot.conversationId, expectedRevision: snapshot.revision, clientMessageId: randomUUID(), message: "Revenue?" };
}

describe("browser conversation synchronization", () => {
  it("saves recovery before submission, clears after acceptance, and reloads authoritative state", async () => {
    const f = fixture();
    await f.controller.initialize();
    f.controller.setDraft("Revenue?");
    await f.controller.sendMessage();
    expect(f.storage.savePending).toHaveBeenCalledOnce();
    expect(vi.mocked(f.storage.savePending).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.api.submit).mock.invocationCallOrder[0]);
    expect(f.storedPending()).toBeNull();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "", phase: "ready", snapshot: { revision: "v1:1:4" } });
    expect(f.api.load).toHaveBeenCalledTimes(2);
  });

  it("blocks double clicking Send while the first request is unresolved", async () => {
    const f = fixture();
    await f.controller.initialize();
    const waiting = deferred<void>();
    vi.mocked(f.api.submit).mockReturnValue(waiting.promise);
    f.controller.setDraft("Revenue?");
    const first = f.controller.sendMessage();
    await f.controller.sendMessage();
    expect(f.api.submit).toHaveBeenCalledOnce();
    waiting.resolve();
    await first;
  });

  it("preserves a draft and does not send when recovery cannot be saved", async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.storage.savePending).mockImplementation(() => { throw new Error("storage denied"); });
    f.controller.setDraft("Revenue?");
    await f.controller.sendMessage();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "Revenue?", storageError: expect.stringContaining("recovery record") });
  });

  it("restores an unaccepted submission on reload without automatically resending", async () => {
    const snapshot = empty();
    const operation = pendingMessage(snapshot);
    const f = fixture(snapshot, operation);
    await f.controller.initialize();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "Revenue?", recovery: operation, phase: "ready" });
    await f.controller.resend();
    expect(f.api.submit).toHaveBeenCalledWith(operation, expect.any(AbortSignal), expect.any(Function));
  });

  it("recovers a saved answer after a lost response without running another analysis", async () => {
    const snapshot = empty();
    const operation = pendingMessage(snapshot);
    const f = fixture(complete(running(snapshot, operation)), operation);
    await f.controller.initialize();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.storedPending()).toBeNull();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "", recovery: null, phase: "ready" });
  });

  it("polls a recovered active attempt until terminal without overlapping polls", async () => {
    vi.useFakeTimers();
    const snapshot = empty();
    const operation = pendingMessage(snapshot);
    const server = running(snapshot, operation);
    const f = fixture(server, operation);
    await f.controller.initialize();
    const waiting = deferred<ConversationSnapshot>();
    vi.mocked(f.api.load).mockReturnValueOnce(waiting.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.api.load).toHaveBeenCalledTimes(2);
    const concurrent = f.controller.sync();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.api.load).toHaveBeenCalledTimes(2);
    waiting.resolve(complete(server));
    await concurrent;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.api.load).toHaveBeenCalledTimes(2);
    expect(f.controller.getSnapshot().phase).toBe("ready");
  });

  it("pauses polling while unavailable and immediately refreshes when available", async () => {
    vi.useFakeTimers();
    const snapshot = empty();
    const operation = pendingMessage(snapshot);
    const f = fixture(running(snapshot, operation));
    await f.controller.initialize();
    f.controller.setAvailable(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.api.load).toHaveBeenCalledOnce();
    f.controller.setAvailable(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.load).toHaveBeenCalledTimes(2);
  });

  it("requires review of changed context and preserves the original pending text", async () => {
    const snapshot = empty();
    const operation = pendingMessage(snapshot);
    const anotherOperation = pendingMessage(snapshot);
    const f = fixture(complete(running(snapshot, anotherOperation)), operation);
    await f.controller.initialize();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "Revenue?", recovery: null, error: expect.stringContaining("Review") });
    expect(f.storedPending()).toBeNull();
    await f.controller.sendMessage();
    const sent = vi.mocked(f.api.submit).mock.calls[0][0];
    expect(sent.clientMessageId).not.toBe(operation.clientMessageId);
    expect(sent.expectedRevision).toBe("v1:1:4");
  });

  it("reconciles an uncertain POST before offering resend with its original identity", async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.api.submit).mockRejectedValueOnce(new Error("connection lost"));
    f.controller.setDraft("Revenue?");
    await f.controller.sendMessage();
    const sent = vi.mocked(f.api.submit).mock.calls[0][0];
    expect(f.controller.getSnapshot().recovery).toEqual(sent);
    expect(f.api.submit).toHaveBeenCalledOnce();
    await f.controller.resend();
    expect(vi.mocked(f.api.submit).mock.calls[1][0].clientMessageId).toBe(sent.clientMessageId);
  });

  it("preserves draft on a stale rejection and refreshes before another send", async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.api.submit).mockRejectedValueOnce(new ChatRequestError(409, { code: "stale_revision", message: "Review refreshed history" }));
    f.controller.setDraft("Mobile only");
    await f.controller.sendMessage();
    expect(f.controller.getSnapshot()).toMatchObject({ draft: "Mobile only", recovery: null, phase: "ready", error: "Review refreshed history" });
    expect(f.storedPending()).toBeNull();
  });

  it("ignores a delayed older GET after a newer stream snapshot", async () => {
    const f = fixture();
    await f.controller.initialize();
    const old = f.controller.getSnapshot().snapshot;
    if (!old) throw new Error("Expected conversation");
    const read = deferred<ConversationSnapshot>();
    vi.mocked(f.api.load).mockReturnValueOnce(read.promise);
    const polling = f.controller.sync();
    const submitted = deferred<void>();
    let notify: ((event: ChatStreamEvent) => void) | undefined;
    vi.mocked(f.api.submit).mockImplementation((_operation, _signal, onEvent) => {
      notify = onEvent;
      return submitted.promise;
    });
    f.controller.setDraft("Revenue?");
    const posting = f.controller.sendMessage();
    const operation = vi.mocked(f.api.submit).mock.calls[0][0];
    const newer = complete(running(old, operation));
    notify?.({ kind: "answer", runId: newer.turns[0].attempts[0].id, snapshot: newer });
    read.resolve(old);
    await polling;
    expect(f.controller.getSnapshot().snapshot?.revision).toBe("v1:1:4");
    f.setServer(newer);
    submitted.resolve();
    await posting;
  });

  it("aborts old requests and ignores their replies after switching conversation", async () => {
    const f = fixture();
    await f.controller.initialize();
    const old = f.controller.getSnapshot().snapshot;
    if (!old) throw new Error("Expected conversation");
    const waiting = deferred<void>();
    let signal: AbortSignal | undefined;
    let notify: ((event: ChatStreamEvent) => void) | undefined;
    vi.mocked(f.api.submit).mockImplementation((_operation, incoming, onEvent) => {
      signal = incoming;
      notify = onEvent;
      return waiting.promise;
    });
    f.controller.setDraft("Revenue?");
    const posting = f.controller.sendMessage();
    const operation = vi.mocked(f.api.submit).mock.calls[0][0];
    await f.controller.newConversation();
    const newId = f.controller.getSnapshot().snapshot?.conversationId;
    expect(newId).not.toBe(old.conversationId);
    expect(signal?.aborted).toBe(true);
    const saved = complete(running(old, operation));
    notify?.({ kind: "answer", runId: saved.turns[0].attempts[0].id, snapshot: saved });
    waiting.resolve();
    await posting;
    expect(f.controller.getSnapshot().snapshot?.conversationId).toBe(newId);
    expect(f.controller.getSnapshot().draft).toBe("");
  });

  it("offers analysis retry only for the latest eligible attempt", () => {
    const snapshot = empty();
    expect(canRetry(snapshot)).toBe(false);
    const active = running(snapshot, pendingMessage(snapshot));
    expect(canRetry(active)).toBe(false);
    active.turns[0].attempts[0] = {
      ...active.turns[0].attempts[0], status: "failed",
      outcome: { kind: "failure", status: "failed", error: { code: "provider", message: "Failure" } },
    };
    expect(canRetry(active)).toBe(true);
    expect(canRetry(complete(active))).toBe(false);
  });
});
