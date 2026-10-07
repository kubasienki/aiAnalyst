import "server-only";
import type { AgentCheckpoint, AgentResult, AgentRunInput } from "../agent/runner-contracts";
import type { ModelCallTrace } from "../agent/contracts";
import type { JsonValue } from "../contracts/json";
import type { BuiltContext } from "../context/contracts";
import type { EvidenceInput, StoredEvidence } from "../conversations/contracts";
import type { ExecutionContext } from "../data/types";
import type { AnalysisOutcome } from "./contracts";

export type AnalysisEvidenceArtifact = {
  kind: "query_evidence";
  input: EvidenceInput;
  delivery: "visible" | "unavailable";
};

export type AnalysisCheckpoint = AgentCheckpoint<AnalysisOutcome, AnalysisEvidenceArtifact>;

export type AnalysisRunState = {
  // Owned by one analysis invocation, shared by all its SQL attempts.
  queryExecution: ExecutionContext;
  // Only the analysis service adds evidence after an awaited checkpoint.
  visibleEvidence: ReadonlyMap<string, EvidenceInput>;
};

export type AnalysisRunInput = {
  conversationId: string;
  context: Pick<BuiltContext, "messages" | "includedEvidenceIds">;
  storedEvidence: StoredEvidence[];
  signal: AbortSignal;
  // Caller-owned absolute Unix milliseconds; never renewed by a tool.
  deadline: number;
  checkpoint(event: AnalysisCheckpoint): Promise<void>;
  recordModelCall?(trace: ModelCallTrace): Promise<void>;
  recordToolCall?(trace: { name: string; argumentsValue: JsonValue; result: JsonValue | null; startedAt: number; finishedAt: number; error?: string }): Promise<void>;
};

export type AnalysisRunner = (
  input: AgentRunInput<AnalysisRunState, AnalysisOutcome, AnalysisEvidenceArtifact>,
) => Promise<AgentResult<AnalysisOutcome>>;
