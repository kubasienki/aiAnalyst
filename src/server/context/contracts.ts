import "server-only";
import type { ModelMessage, ModelRequest } from "../agent/contracts";
import type { ConversationEvent, ConversationRun, StoredEvidence } from "../conversations/contracts";
import type { ConversationHistory } from "../conversations/repository";

export type ContextErrorCode = "invalid_history" | "missing_evidence" | "replay_mismatch" | "configuration" | "context_limit";

export class ContextError extends Error {
  constructor(public readonly code: ContextErrorCode, message: string) {
    super(message);
    this.name = "ContextError";
  }
}

// These are reconstruction units, not stored records. A retry's user unit may
// reference the original event owned by an earlier attempt.
export type HistoryInteraction = {
  runId: string;
  kind: "user" | "assistant" | "tool_interaction" | "outcome" | "note";
  events: ConversationEvent[];
  complete: boolean;
};

export type ReconstructedHistory = {
  interactions: HistoryInteraction[];
  runs: Map<string, ConversationRun>;
  evidence: Map<string, StoredEvidence>;
  terminalOutcomes: Map<string, ConversationEvent>;
};

export type ExcludedInteraction = {
  runId: string;
  assistantEventId: string;
  eventIds: string[];
  reason: "incomplete_interaction";
};

export type ContextSelection = {
  interactions: HistoryInteraction[];
  excludedInteractions: ExcludedInteraction[];
};

export type RequestMeasurement = {
  requestBytes: number;
  estimatedInputTokens: number;
  estimator: string;
};

export interface ModelRequestMeasurer {
  measure(request: ModelRequest): RequestMeasurement;
}

export type ContextBudget = {
  contextWindowTokens: number;
  safetyTokens: number;
};

export type ContextMeasurement = RequestMeasurement & {
  contextWindowTokens: number;
  outputReservationTokens: number;
  safetyReservationTokens: number;
  remainingInputTokens: number;
};

export type BuildContextInput = {
  history: ConversationHistory;
  targetRunId: string;
  instructions: string[];
  requestSettings: Omit<ModelRequest, "messages">;
};

export type BuiltContext = {
  messages: ModelMessage[];
  includedEventIds: string[];
  includedEvidenceIds: string[];
  excludedInteractions: ExcludedInteraction[];
  measurement: ContextMeasurement;
};
