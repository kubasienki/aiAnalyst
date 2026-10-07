import "server-only";
import type { JsonValue } from "../contracts/json";
import type { AgentModel, ModelCallTrace, ModelMessage, ModelRequest, ModelResponse, RegisteredTool } from "./contracts";

export type AgentFailureCode = "configuration" | "protocol" | "provider" | "timeout" | "cancelled"
  | "deadline" | "budget_exhausted" | "context_limit" | "persistence" | "internal";

export class AgentRunnerError extends Error {
  constructor(public readonly code: AgentFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunnerError";
  }
}

export type AgentStatistics = { modelRequests: number; toolExecutions: number; recoverableErrors: number; elapsedMs: number };
export type AgentResult<TOutcome> =
  | { kind: "terminal"; outcome: TOutcome; statistics: AgentStatistics }
  | { kind: "failure"; error: { code: AgentFailureCode; message: string }; statistics: AgentStatistics };

// Awaited server-owned persistence records, not browser progress events.
// The terminal checkpoint must save acknowledgment and outcome atomically.
export type AgentCheckpoint<TOutcome, TArtifact = never> =
  | { kind: "assistant"; response: ModelResponse }
  | { kind: "context_note"; content: string }
  | { kind: "tool_result"; callId: string; content: JsonValue; artifact?: TArtifact }
  | { kind: "terminal"; callId: string; acknowledgment: JsonValue; outcome: TOutcome };

export type AgentLimits = { maxModelRequests: number; maxOutputTokens: number };
export type AgentRunInput<TContext, TOutcome, TArtifact = never> = {
  messages: ModelMessage[];
  tools: RegisteredTool<TContext, TOutcome, TArtifact>[];
  applicationContext: TContext;
  signal: AbortSignal;
  // One caller-owned absolute run deadline, in milliseconds since Unix epoch.
  deadline: number;
  limits?: Partial<AgentLimits>;
  // The adapter must complete or reject started writes. The runner deliberately
  // does not race them against cancellation because terminal writes can commit.
  checkpoint(event: AgentCheckpoint<TOutcome, TArtifact>): Promise<void>;
  recordModelCall?(trace: ModelCallTrace): Promise<void>;
  recordToolCall?(trace: { name: string; argumentsValue: JsonValue; result: JsonValue | null; startedAt: number; finishedAt: number; error?: string }): Promise<void>;
};

export type RunnerPhase = "configuration" | "preflight" | "model" | "checkpoint" | "action" | "tool";
export type AgentDiagnostic = {
  // Internal categories preserve the boundary failure without exposing error text.
  origin?: { boundary: "model" | "context" | "checkpoint"; category: string };
  category: AgentFailureCode;
  phase: RunnerPhase;
  modelRequests: number;
  toolExecutions: number;
  elapsedMs: number;
};

export type AgentRunnerDependencies = {
  model: AgentModel;
  preflight(request: ModelRequest): void;
  reportFailure?(diagnostic: AgentDiagnostic): void;
};
