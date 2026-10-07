import { MAX_USER_MESSAGE_LENGTH } from "../../shared/chat";
import { isOlderRevision, type ChatStreamEvent, type ConversationSnapshot, type DisplayAttempt } from "../../shared/conversations";
import { ChatRequestError, type ChatApi } from "./chat-api";
import type { ChatStorage, PendingOperation } from "./storage";

export type ChatPhase = "loading" | "ready" | "submitting" | "running" | "reconnecting";
export type ChatState = {
  snapshot: ConversationSnapshot | null;
  phase: ChatPhase;
  progress: "thinking" | "querying";
  error: string | null;
  storageError: string | null;
  draft: string;
  recovery: PendingOperation | null;
  conversationKey: number;
  online: boolean;
};

const initialState: ChatState = {
  snapshot: null,
  phase: "loading",
  progress: "thinking",
  error: null,
  storageError: null,
  draft: "",
  recovery: null,
  conversationKey: 0,
  online: true,
};

export function latestAttempt(snapshot: ConversationSnapshot | null): DisplayAttempt | undefined {
  return snapshot?.turns.at(-1)?.attempts.at(-1);
}

export function canRetry(snapshot: ConversationSnapshot | null): boolean {
  const status = latestAttempt(snapshot)?.status;
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

// This controller owns browser workflow, not rendering or server lifecycle.
// Mutable request identities and timers belong to one mounted chat instance.
export class ChatController {
  private state: ChatState = initialState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private conversationId: string | null = null;
  private pending: PendingOperation | null = null;
  private activePost: AbortController | null = null;
  private activeRead: AbortController | null = null;
  private readCompletion: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private available = true;
  private disposed = false;

  constructor(private readonly dependencies: { api: ChatApi; storage: ChatStorage; newId: () => string }) {}

  getSnapshot = (): ChatState => this.state;
  getServerSnapshot = (): ChatState => initialState;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: Partial<ChatState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePoll(): void {
    this.stopTimer();
    if (!this.available || this.disposed || this.state.recovery) {
      return;
    }
    if (latestAttempt(this.state.snapshot)?.status !== "running" && this.state.phase !== "reconnecting") {
      return;
    }
    // Two seconds between settled polls; there is never overlapping polling.
    this.timer = setTimeout(() => { void this.sync(); }, 2_000);
  }

  private clearPending(): void {
    this.pending = null;
    try {
      this.dependencies.storage.clearPending();
    } catch {
      this.update({ storageError: "The recovery record could not be cleared. Server history is still saved." });
    }
  }

  private applySnapshot(snapshot: ConversationSnapshot): boolean {
    if (snapshot.conversationId !== this.conversationId) {
      throw new Error("The server returned another conversation.");
    }
    const previous = this.state.snapshot;
    if (previous && isOlderRevision(snapshot.revision, previous.revision)) {
      return false;
    }
    let recovery: PendingOperation | null = null;
    if (this.pending) {
      const accepted = snapshot.turns.some(turn => turn.attempts.some(attempt => attempt.clientMessageId === this.pending?.clientMessageId));
      if (accepted) {
        if (this.pending.kind === "message") {
          this.update({ draft: "" });
        }
        this.clearPending();
      } else if (!this.activePost) {
        if (this.pending.expectedRevision !== snapshot.revision) {
          const draft = this.pending.kind === "message" ? this.pending.message : this.state.draft;
          this.clearPending();
          this.update({ draft, error: "Conversation changed. Review the refreshed history before sending." });
        } else {
          recovery = this.pending;
        }
      }
    }
    let phase: ChatPhase = "ready";
    if (this.activePost) {
      phase = "submitting";
    }
    if (latestAttempt(snapshot)?.status === "running") {
      phase = "running";
    }
    this.update({ snapshot, phase, recovery });
    return true;
  }

  async initialize(): Promise<void> {
    this.disposed = false;
    const generation = ++this.generation;
    try {
      this.conversationId = this.dependencies.storage.loadActiveId();
      this.pending = this.dependencies.storage.loadPending();
      if (this.pending) {
        // Pending work owns its identity even if a fallback pointer changed.
        this.conversationId = this.pending.conversationId;
        if (this.pending.kind === "message") {
          this.update({ draft: this.pending.message });
        }
      }
    } catch {
      this.update({ phase: "reconnecting", storageError: "Saved conversation recovery could not be loaded. Start a new conversation to continue." });
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    await this.sync();
  }

  sync = async (): Promise<void> => {
    if (this.disposed || !this.available) {
      return;
    }
    if (this.readCompletion) {
      return this.readCompletion;
    }
    this.stopTimer();
    const generation = this.generation;
    const controller = new AbortController();
    this.activeRead = controller;
    const completion = (async () => {
      try {
        let snapshot: ConversationSnapshot;
        if (this.conversationId) {
          snapshot = await this.dependencies.api.load(this.conversationId, controller.signal);
        } else {
          snapshot = await this.dependencies.api.create(controller.signal);
        }
        if (!this.isCurrent(generation)) {
          return;
        }
        this.conversationId = snapshot.conversationId;
        try {
          this.dependencies.storage.saveActiveId(snapshot.conversationId);
        } catch {
          this.update({ storageError: "Conversation identity could not be saved. Keep this tab open until storage is available." });
        }
        if (this.state.phase === "reconnecting" || this.state.phase === "loading") {
          this.update({ error: null });
        }
        this.applySnapshot(snapshot);
      } catch (error) {
        if (!this.isCurrent(generation) || controller.signal.aborted) {
          return;
        }
        let message = "Conversation status could not be loaded. Check status before sending.";
        if (error instanceof ChatRequestError && error.status === 404) {
          message = "This conversation is unavailable. Start a new conversation.";
        }
        this.update({ phase: "reconnecting", error: message });
      } finally {
        if (this.activeRead === controller) {
          this.activeRead = null;
          this.readCompletion = null;
          this.schedulePoll();
        }
      }
    })();
    this.readCompletion = completion;
    return completion;
  };

  setDraft = (draft: string): void => {
    this.update({ draft });
  };

  private handleEvent(event: ChatStreamEvent, operation: PendingOperation): void {
    if (event.runId && event.kind === "progress") {
      const current = latestAttempt(this.state.snapshot);
      if (current?.id === event.runId && current.status === "running") {
        this.update({ phase: "running", progress: event.phase });
      }
      return;
    }
    if ("snapshot" in event && event.snapshot) {
      const attempt = event.snapshot.turns.flatMap(turn => turn.attempts)
        .find(item => item.id === event.runId && item.clientMessageId === operation.clientMessageId);
      if (!attempt) {
        throw new Error("The stream returned a different submission.");
      }
      if (this.applySnapshot(event.snapshot) && event.kind === "accepted" && operation.kind === "message") {
        this.update({ draft: "" });
      }
    } else if (event.kind === "error") {
      this.update({ phase: "reconnecting", error: event.error?.message ?? "The analysis outcome could not be confirmed. Check status." });
    }
  }

  private async submit(operation: PendingOperation): Promise<void> {
    if (this.activePost || this.disposed || !this.available) {
      return;
    }
    try {
      this.dependencies.storage.saveActiveId(operation.conversationId);
      this.dependencies.storage.savePending(operation);
    } catch {
      this.update({ storageError: "The message recovery record could not be saved. Your draft is preserved; enable browser storage before sending." });
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = operation;
    this.activePost = controller;
    this.update({ phase: "submitting", recovery: null, error: null, storageError: null, progress: "thinking" });
    try {
      await this.dependencies.api.submit(operation, controller.signal, event => {
        if (this.isCurrent(generation) && this.activePost === controller) {
          this.handleEvent(event, operation);
        }
      });
    } catch (error) {
      if (!this.isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      if (error instanceof ChatRequestError && [400, 404, 409].includes(error.status)) {
        this.clearPending();
        this.update({
          error: error.message,
          draft: operation.kind === "message" ? operation.message : this.state.draft,
          recovery: null,
        });
      } else {
        this.update({ phase: "reconnecting", error: "Connection interrupted. Checking whether your message was saved…" });
      }
    } finally {
      if (this.activePost === controller) {
        this.activePost = null;
        await this.sync();
      }
    }
  }

  sendMessage = async (content = this.state.draft): Promise<void> => {
    const snapshot = this.state.snapshot;
    const message = content.trim();
    if (!snapshot || this.state.phase !== "ready" || this.state.recovery || !message || message.length > MAX_USER_MESSAGE_LENGTH) {
      return;
    }
    this.update({ draft: message });
    await this.submit({
      kind: "message",
      conversationId: snapshot.conversationId,
      clientMessageId: this.dependencies.newId(),
      expectedRevision: snapshot.revision,
      message,
    });
  };

  retry = async (): Promise<void> => {
    const snapshot = this.state.snapshot;
    const attempt = latestAttempt(snapshot);
    if (!snapshot || !attempt || !canRetry(snapshot) || this.state.phase !== "ready" || this.state.recovery) {
      return;
    }
    await this.submit({
      kind: "retry",
      conversationId: snapshot.conversationId,
      runId: attempt.id,
      clientMessageId: this.dependencies.newId(),
      expectedRevision: snapshot.revision,
    });
  };

  resend = async (): Promise<void> => {
    if (this.state.recovery) {
      await this.submit(this.state.recovery);
    }
  };

  reviewRecovery = (): void => {
    const operation = this.state.recovery;
    if (!operation) {
      return;
    }
    this.clearPending();
    this.update({ recovery: null, draft: operation.kind === "message" ? operation.message : this.state.draft });
  };

  setAvailable = (available: boolean): void => {
    this.available = available;
    if (!available) {
      this.stopTimer();
      return;
    }
    void this.sync();
  };

  setOnline = (online: boolean): void => {
    this.update({
      online,
      ...(!online ? { error: "Offline. Your saved conversation is still available when you reconnect." } : {}),
    });
  };

  newConversation = async (): Promise<void> => {
    ++this.generation;
    this.activePost?.abort();
    this.activePost = null;
    this.activeRead?.abort();
    this.activeRead = null;
    this.readCompletion = null;
    this.stopTimer();
    this.clearPending();
    this.conversationId = null;
    this.update({ ...initialState, conversationKey: this.state.conversationKey + 1 });
    await this.sync();
  };

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.activePost?.abort();
    this.activePost = null;
    this.activeRead?.abort();
    this.activeRead = null;
    this.readCompletion = null;
    this.stopTimer();
  }
}
