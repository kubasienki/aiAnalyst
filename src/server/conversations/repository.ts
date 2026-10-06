import "server-only";
import type { AssistantMessage } from "../agent/contracts";
import type {
  Conversation, ConversationEvent, ConversationRun, EvidenceInput,
  RunOutcome, RunVersions, StoredEvidence, StoredToolResult,
} from "./contracts";

export class ConversationRepositoryError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid_input" | "invalid_record" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationRepositoryError";
  }
}

export type StartRunInput = {
  conversationId: string;
  clientMessageId: string;
  message: string;
  deadline: number;
  versions: RunVersions;
};

export type RetryRunInput = Omit<StartRunInput, "message"> & { runId: string };
export type StartRunResult = { run: ConversationRun; created: boolean };
export type FinishRunInput = { outcome: RunOutcome; acknowledgment?: StoredToolResult };

export type ConversationHistory = {
  conversation: Conversation;
  runs: ConversationRun[];
  events: ConversationEvent[];
  evidence: StoredEvidence[];
};

export interface ConversationRepository {
  createConversation(): Promise<Conversation>;
  getConversation(conversationId: string): Promise<Conversation>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  retryRun(input: RetryRunInput): Promise<StartRunResult>;
  appendAssistant(runId: string, message: AssistantMessage): Promise<ConversationEvent>;
  appendContextNote(runId: string, content: string): Promise<ConversationEvent>;
  recordToolResult(runId: string, result: StoredToolResult, evidence?: EvidenceInput): Promise<ConversationEvent>;
  finishRun(runId: string, input: FinishRunInput): Promise<ConversationRun>;
  loadHistory(conversationId: string): Promise<ConversationHistory>;
  getEvidence(conversationId: string, evidenceId: string): Promise<StoredEvidence>;
  interruptExpiredRuns(now: number): Promise<number>;
  close(): void;
}
