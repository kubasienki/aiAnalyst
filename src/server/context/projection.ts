import "server-only";
import type { ModelMessage } from "../agent/contracts";
import { jsonValueSchema, type JsonValue } from "../contracts/json";
import type { ConversationEvent } from "../conversations/contracts";
import { ContextError, type ContextSelection, type ReconstructedHistory } from "./contracts";
import { projectEvidence } from "./evidence";

function projectResult(
  event: ConversationEvent,
  history: ReconstructedHistory,
  visibleEvidence: Set<string>,
): JsonValue {
  if (event.payload.kind !== "tool_result") {
    throw new ContextError("invalid_history", "Expected a stored tool result.");
  }
  const payload = event.payload.result.payload;
  if (payload.kind === "evidence_unavailable") {
    // The ID is a retrieval reference, not proof the model has seen its rows.
    return { kind: payload.kind, evidenceId: payload.evidenceId, content: payload.content };
  }
  if (payload.kind === "evidence") {
    const evidence = history.evidence.get(payload.evidenceId);
    if (!evidence) {
      throw new ContextError("missing_evidence", "A referenced query result is missing from the conversation snapshot.");
    }
    const content = projectEvidence(evidence);
    visibleEvidence.add(payload.evidenceId);
    return content;
  }
  const terminal = history.terminalOutcomes.get(event.id);
  if (terminal?.payload.kind === "outcome") {
    return jsonValueSchema.parse(JSON.parse(JSON.stringify({ acknowledgment: payload.content, outcome: terminal.payload.outcome })));
  }
  return payload.content;
}

export function projectContext(selection: ContextSelection, history: ReconstructedHistory) {
  const messages: ModelMessage[] = [];
  const eventIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const interaction of selection.interactions) {
    for (const event of interaction.events) {
      eventIds.add(event.id);
      const payload = event.payload;
      switch (payload.kind) {
        case "context_note":
          messages.push({ role: "system", content: payload.content });
          break;
        case "user_message":
          messages.push({ role: "user", content: payload.content });
          break;
        case "assistant_message":
          messages.push(payload.message);
          break;
        case "tool_result":
          messages.push({
            role: "tool",
            callId: payload.result.callId,
            content: projectResult(event, history, evidenceIds),
          });
          break;
        case "outcome":
          if (payload.outcome.kind === "failure") {
            messages.push({
              role: "system",
              content: `Application status: attempt ${interaction.runId} ended as ${payload.outcome.status} (${payload.outcome.error.code}). Earlier tool results are intermediate evidence; this attempt did not produce an accepted answer. Unfinished tools were not resumed.`,
            });
          }
          break;
      }
    }
  }
  return { messages, includedEventIds: [...eventIds], includedEvidenceIds: [...evidenceIds] };
}
