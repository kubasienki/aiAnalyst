import "server-only";
import { ContextError } from "../context/contracts";
import { projectEvidence } from "../context/evidence";
import { identitySchema, storedEvidenceSchema, type EvidenceInput } from "../conversations/contracts";
import { createExecutionContext } from "../data/execution-context";
import type { QueryExecutor } from "../data/types";
import { createAnalysisTools } from "./tools";
import type { AnalysisRunInput, AnalysisRunner } from "./types";

function seedVisibleEvidence(input: AnalysisRunInput): Map<string, EvidenceInput> {
  const visible = new Map<string, EvidenceInput>();
  const stored = new Map<string, EvidenceInput>();
  if (!identitySchema.safeParse(input.conversationId).success) {
    throw new ContextError("configuration", "Analysis requires a valid conversation identity.");
  }
  for (const record of input.storedEvidence) {
    const parsed = storedEvidenceSchema.safeParse(record);
    if (!parsed.success || parsed.data.conversationId !== input.conversationId || stored.has(parsed.data.evidence.resultId)) {
      throw new ContextError("invalid_history", "Historical evidence ownership or identity is invalid.");
    }
    stored.set(parsed.data.evidence.resultId, parsed.data);
  }
  const deliveredPayloads = new Set(input.context.messages
    .filter(message => message.role === "tool")
    .map(message => JSON.stringify(message.content)));
  for (const id of input.context.includedEvidenceIds) {
    const evidence = stored.get(id);
    if (!evidence || visible.has(id) || !deliveredPayloads.has(JSON.stringify(projectEvidence(evidence)))) {
      throw new ContextError("missing_evidence", "Included evidence must have its complete projected payload in model context.");
    }
    visible.set(id, evidence);
  }
  return visible;
}

export function createAnalysisService(dependencies: { runAgent: AnalysisRunner; executeQuery: QueryExecutor }) {
  const tools = createAnalysisTools(dependencies.executeQuery);
  return async function analyze(input: AnalysisRunInput) {
    const visibleEvidence = seedVisibleEvidence(input);
    const queryExecution = createExecutionContext({ signal: input.signal, deadline: input.deadline });
    return dependencies.runAgent({
      messages: input.context.messages,
      tools,
      applicationContext: { queryExecution, visibleEvidence },
      signal: input.signal,
      deadline: input.deadline,
      async checkpoint(event) {
        await input.checkpoint(event);
        // Handlers do not grant visibility. Only durably checkpointed, fully
        // delivered evidence can support the next action or final answer.
        if (event.kind === "tool_result" && event.artifact?.delivery === "visible") {
          const evidence = event.artifact.input;
          if (visibleEvidence.has(evidence.evidence.resultId)) {
            throw new ContextError("invalid_history", "A new query reused an existing evidence identity.");
          }
          visibleEvidence.set(evidence.evidence.resultId, evidence);
        }
      },
    });
  };
}
