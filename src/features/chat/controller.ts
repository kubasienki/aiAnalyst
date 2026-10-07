import { MAX_USER_MESSAGE_LENGTH } from "../../shared/chat";
import { isOlderRevision, type ChatStreamEvent, type ConversationSnapshot, type DisplayAttempt } from "../../shared/conversations";
import { ChatRequestError, type ChatApi } from "./chat-api";
import type { ChatStorage, PendingOperation } from "./storage";
import { reconcilePendingOperation } from "./snapshot-reconciliation";

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
  requestActive: boolean;
  cancelling: boolean;
};

type ChatControllerDependencies = {
  api: ChatApi;
  storage: ChatStorage;
  newId(): string;
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
  requestActive: false,
  cancelling: false,
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
  // Incremented when a conversation lifecycle starts or ends. Replies from an
  // older lifecycle must not publish state, even if their requests ignore abort.
  private generation = 0;
  // Survives post-submission synchronization after the active request is cleared.
  private latestSubmissionId = 0;
  private conversationId: string | null = null;
  private pending: PendingOperation | null = null;
  private activeSubmissionController: AbortController | null = null;
  private activeSnapshotController: AbortController | null = null;
  private snapshotReadCompletion: Promise<void> | null = null;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private available = true;
  private disposed = false;
  private conversationUnavailable = false;

  constructor(private readonly dependencies: ChatControllerDependencies) {}

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

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private schedulePoll(): void {
    this.stopPolling();
    if (!this.available || this.disposed || this.state.recovery || this.conversationUnavailable) {
      return;
    }
    if (latestAttempt(this.state.snapshot)?.status !== "running" && this.state.phase !== "reconnecting") {
      return;
    }
    // Two seconds between settled polls; there is never overlapping polling.
    this.pollingTimer = setTimeout(() => {
      void this.sync();
    }, 2_000);
  }

  private clearPending(): void {
    this.pending = null;
    try {
      this.dependencies.storage.clearPending();
    } catch {
      this.update({
        storageError: "The recovery record could not be cleared. Server history is still saved.",
      });
    }
  }

  private reconcilePendingSubmission(snapshot: ConversationSnapshot): PendingOperation | null {
    const decision = reconcilePendingOperation({
      pendingOperation: this.pending,
      snapshot,
      draft: this.state.draft,
      submissionInFlight: this.activeSubmissionController !== null,
    });
    switch (decision.kind) {
      case "accepted":
        if (decision.draft !== this.state.draft) {
          this.update({ draft: decision.draft });
        }
        this.clearPending();
        return null;
      case "stale_revision":
        this.clearPending();
        this.update({
          draft: decision.draft,
          error: "Conversation changed. Review the refreshed history before sending.",
        });
        return null;
      case "recoverable":
        return decision.operation;
      case "no_pending_operation":
      case "submission_in_flight":
        return null;
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
    const recovery = this.reconcilePendingSubmission(snapshot);
    let phase: ChatPhase = "ready";
    if (this.activeSubmissionController) {
      phase = "submitting";
    }
    if (latestAttempt(snapshot)?.status === "running") {
      phase = "running";
    }
    this.update({
      snapshot,
      phase,
      recovery,
    });
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
      this.update({
        phase: "reconnecting",
        storageError: "Saved conversation recovery could not be loaded. Start a new conversation to continue.",
      });
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    await this.sync();
  }

  private async loadOrCreateSnapshot(signal: AbortSignal): Promise<ConversationSnapshot> {
    if (this.conversationId) {
      return this.dependencies.api.load(this.conversationId, signal);
    }
    return this.dependencies.api.create(signal);
  }

  private rememberConversationIdentity(conversationId: string): void {
    this.conversationId = conversationId;
    try {
      this.dependencies.storage.saveActiveId(conversationId);
    } catch {
      this.update({
        storageError: "Conversation identity could not be saved. Keep this tab open until storage is available.",
      });
    }
  }

  private handleSnapshotReadFailure(error: unknown): void {
    let message = "Conversation status could not be loaded. Check status before sending.";
    if (error instanceof ChatRequestError && error.status === 404) {
      message = "This conversation is unavailable. Start a new conversation.";
      this.conversationUnavailable = true;
    }
    this.update({
      phase: "reconnecting",
      error: message,
    });
  }

  sync = async (): Promise<void> => {
    if (this.disposed || !this.available) {
      return;
    }
    if (this.snapshotReadCompletion) {
      return this.snapshotReadCompletion;
    }
    this.stopPolling();
    const generation = this.generation;
    const controller = new AbortController();
    this.activeSnapshotController = controller;
    const completion = (async () => {
      try {
        const snapshot = await this.loadOrCreateSnapshot(controller.signal);
        if (!this.isCurrent(generation) || this.activeSnapshotController !== controller) {
          return;
        }
        this.conversationUnavailable = false;
        this.rememberConversationIdentity(snapshot.conversationId);
        if (this.state.phase === "reconnecting" || this.state.phase === "loading") {
          this.update({ error: null });
        }
        this.applySnapshot(snapshot);
      } catch (error) {
        if (!this.isCurrent(generation) || controller.signal.aborted) {
          return;
        }
        this.handleSnapshotReadFailure(error);
      } finally {
        if (this.activeSnapshotController === controller) {
          this.activeSnapshotController = null;
          this.snapshotReadCompletion = null;
          this.schedulePoll();
        }
      }
    })();
    this.snapshotReadCompletion = completion;
    return completion;
  };

  setDraft = (draft: string): void => {
    this.update({ draft });
  };

  cancel = (): void => {
    if (!this.activeSubmissionController || this.state.cancelling) {
      return;
    }
    this.update({ cancelling: true });
    this.activeSubmissionController.abort();
  };

  private handleEvent(event: ChatStreamEvent, operation: PendingOperation): void {
    if (event.kind === "progress") {
      const current = latestAttempt(this.state.snapshot);
      if (current?.id === event.runId && current.status === "running") {
        this.update({
          phase: "running",
          progress: event.phase,
        });
      }
      return;
    }
    if ("snapshot" in event && event.snapshot) {
      const attempt = event.snapshot.turns.flatMap(turn => turn.attempts)
        .find(item => item.id === event.runId && item.clientMessageId === operation.clientMessageId);
      if (!attempt) {
        throw new Error("The stream returned a different submission.");
      }
      const snapshotApplied = this.applySnapshot(event.snapshot);
      if (snapshotApplied
        && event.kind === "accepted"
        && operation.kind === "message"
        && this.state.draft === operation.message) {
        this.update({ draft: "" });
      }
    } else if (event.kind === "error") {
      this.update({
        phase: "reconnecting",
        error: event.error?.message ?? "The analysis outcome could not be confirmed. Check status.",
      });
    }
  }

  private persistSubmissionRecovery(operation: PendingOperation): boolean {
    try {
      this.dependencies.storage.saveActiveId(operation.conversationId);
      this.dependencies.storage.savePending(operation);
      return true;
    } catch {
      this.update({
        storageError: "The message recovery record could not be saved. Your draft is preserved; enable browser storage before sending.",
      });
      return false;
    }
  }

  private handleSubmissionFailure(error: unknown, operation: PendingOperation): void {
    if (error instanceof ChatRequestError && [400, 404, 409].includes(error.status)) {
      this.clearPending();
      let draft = this.state.draft;
      if (operation.kind === "message") {
        draft = operation.message;
      }
      this.update({
        error: error.message,
        draft,
        recovery: null,
      });
      return;
    }
    this.update({
      phase: "reconnecting",
      error: "Connection interrupted. Checking whether your message was saved…",
    });
  }

  private async submit(operation: PendingOperation): Promise<void> {
    if (this.activeSubmissionController || this.disposed || !this.available) {
      return;
    }
    if (!this.persistSubmissionRecovery(operation)) {
      return;
    }
    const generation = this.generation;
    const submissionId = ++this.latestSubmissionId;
    const controller = new AbortController();
    this.pending = operation;
    this.activeSubmissionController = controller;
    this.update({
      phase: "submitting",
      recovery: null,
      error: null,
      storageError: null,
      progress: "thinking",
      requestActive: true,
      cancelling: false,
    });
    try {
      await this.dependencies.api.submit(operation, controller.signal, event => {
        if (this.isCurrent(generation) && this.activeSubmissionController === controller) {
          this.handleEvent(event, operation);
        }
      });
    } catch (error) {
      if (!this.isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      this.handleSubmissionFailure(error, operation);
    } finally {
      if (this.isCurrent(generation) && this.activeSubmissionController === controller) {
        this.activeSubmissionController = null;
        await this.sync();
        // Synchronization can publish ready state and allow another submission.
        // Recheck ownership after the await, including within this generation.
        if (this.isCurrent(generation) && this.latestSubmissionId === submissionId) {
          this.update({
            requestActive: false,
            cancelling: false,
          });
        }
      }
    }
  }

  sendMessage = async (content = this.state.draft): Promise<void> => {
    const snapshot = this.state.snapshot;
    const message = content.trim();
    if (!snapshot
      || this.state.phase !== "ready"
      || this.state.recovery
      || !message
      || message.length > MAX_USER_MESSAGE_LENGTH) {
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
    if (!snapshot
      || !attempt
      || !canRetry(snapshot)
      || this.state.phase !== "ready"
      || this.state.recovery) {
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
    let draft = this.state.draft;
    if (operation.kind === "message") {
      draft = operation.message;
    }
    this.update({ recovery: null, draft });
  };

  setAvailable = (available: boolean): void => {
    this.available = available;
    if (!available) {
      this.stopPolling();
      return;
    }
    void this.sync();
  };

  setOnline = (online: boolean): void => {
    const change: Partial<ChatState> = { online };
    if (!online) {
      change.error = "Offline. Your saved conversation is still available when you reconnect.";
    }
    this.update(change);
  };

  private stopRequestsAndPolling(): void {
    this.activeSubmissionController?.abort();
    this.activeSubmissionController = null;
    this.activeSnapshotController?.abort();
    this.activeSnapshotController = null;
    this.snapshotReadCompletion = null;
    this.stopPolling();
  }

  newConversation = async (): Promise<void> => {
    ++this.generation;
    this.stopRequestsAndPolling();
    this.clearPending();
    this.conversationId = null;
    this.conversationUnavailable = false;
    this.update({
      ...initialState,
      conversationKey: this.state.conversationKey + 1,
    });
    await this.sync();
  };

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.stopRequestsAndPolling();
  }
}
