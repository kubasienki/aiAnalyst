import "server-only";
import type { AgentCheckpoint, AgentResult, AgentRunInput } from "../agent/runner-contracts";
import type { ModelCallTrace, ToolCallTrace } from "../agent/contracts";
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
  recordModelCall?(trace: ModelCallTrace, signal: AbortSignal): Promise<void>;
  recordToolCall?(trace: ToolCallTrace, signal: AbortSignal): Promise<void>;
};

export type AnalysisRunner = (
  input: AgentRunInput<AnalysisRunState, AnalysisOutcome, AnalysisEvidenceArtifact>,
) => Promise<AgentResult<AnalysisOutcome>>;
