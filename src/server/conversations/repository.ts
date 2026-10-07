import "server-only";
import type { AssistantMessage } from "../agent/contracts";
import type {
  Conversation, ConversationEvent, ConversationRun, EvidenceInput,
  RunOutcome, RunVersions, StoredEvidence, StoredToolResult,
} from "./contracts";

export class ConversationRepositoryError extends Error {
  public readonly conflictReason?: "stale_revision" | "active_run" | "invalid_retry" | "submission_mismatch";

  constructor(
    public readonly code: "not_found" | "conflict" | "invalid_input" | "invalid_record" | "unavailable",
    message: string,
    options?: ErrorOptions & { conflictReason?: ConversationRepositoryError["conflictReason"] },
  ) {
    super(message, options);
    this.name = "ConversationRepositoryError";
    this.conflictReason = options?.conflictReason;
  }
}

export type StartRunInput = {
  conversationId: string;
  clientMessageId: string;
  message: string;
  deadline: number;
  versions: RunVersions;
  expectedRevision: string;
};

export type SubmissionLookup = {
  conversationId: string;
  clientMessageId: string;
  operation: { kind: "message"; message: string } | { kind: "retry"; runId: string };
};

export type RetryRunInput = Omit<StartRunInput, "message"> & { runId: string };
export type StartRunResult = { run: ConversationRun; created: boolean };
export type FinishRunInput = { outcome: RunOutcome; acknowledgment?: StoredToolResult };
export type AgentTraceInput = {
  kind: "model_call" | "tool_call";
  payload: import("../contracts/json").JsonValue;
  startedAt: number;
  finishedAt: number | null;
};

export type ConversationHistory = {
  conversation: Conversation;
  runs: ConversationRun[];
  events: ConversationEvent[];
  evidence: StoredEvidence[];
};

export interface ConversationRepository {
  createConversation(): Promise<Conversation>;
  getConversation(conversationId: string): Promise<Conversation>;
  findSubmission(input: SubmissionLookup): Promise<ConversationRun | null>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  retryRun(input: RetryRunInput): Promise<StartRunResult>;
  appendAssistant(runId: string, message: AssistantMessage): Promise<ConversationEvent>;
  recordAgentTrace(runId: string, trace: AgentTraceInput): Promise<void>;
  appendContextNote(runId: string, content: string): Promise<ConversationEvent>;
  recordToolResult(runId: string, result: StoredToolResult, evidence?: EvidenceInput): Promise<ConversationEvent>;
  finishRun(runId: string, input: FinishRunInput): Promise<ConversationRun>;
  loadHistory(conversationId: string): Promise<ConversationHistory>;
  getEvidence(conversationId: string, evidenceId: string): Promise<StoredEvidence>;
  interruptExpiredRuns(now: number, graceMs?: number): Promise<number>;
  close(): void;
}
