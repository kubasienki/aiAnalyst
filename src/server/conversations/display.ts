import "server-only";
import { conversationRevision, conversationSnapshotSchema, type ConversationSnapshot } from "../../shared/conversations";
import type { ConversationRun, RunOutcome } from "./contracts";
import type { ConversationHistory } from "./repository";

const failureMessages = {
  configuration: "Analysis is not configured. Please try again after configuration is restored.",
  provider: "The AI provider could not complete this analysis.",
  protocol: "The analysis could not be continued safely.",
  timeout: "The AI provider took too long to respond.",
  cancelled: "This analysis was cancelled.",
  deadline: "This analysis reached its time limit.",
  budget_exhausted: "This analysis reached its execution limit without an answer.",
  context_limit: "This conversation is too large to continue. Start a new conversation.",
  persistence: "This analysis could not be saved.",
  interrupted: "This analysis ended without a saved outcome.",
  internal: "This analysis could not be completed.",
} satisfies Record<Extract<RunOutcome, { kind: "failure" }>["error"]["code"], string>;

export function safeOutcome(outcome: RunOutcome | null): RunOutcome | null {
  if (!outcome || outcome.kind !== "failure") {
    return outcome;
  }
  return {
    kind: "failure",
    status: outcome.status,
    error: { code: outcome.error.code, message: failureMessages[outcome.error.code] },
  };
}

export function projectConversation(history: ConversationHistory): ConversationSnapshot {
  const firstSequence = new Map<string, number>();
  for (const event of history.events) {
    if (!firstSequence.has(event.runId)) {
      firstSequence.set(event.runId, event.sequence);
    }
  }
  function orderAttempts(left: ConversationRun, right: ConversationRun): number {
    // Only an active retry can have no events; it follows all terminal attempts.
    return (firstSequence.get(left.id) ?? Infinity) - (firstSequence.get(right.id) ?? Infinity);
  }
  const turns: ConversationSnapshot["turns"] = [];
  for (const event of history.events) {
    if (event.payload.kind !== "user_message") {
      continue;
    }
    const attempts = history.runs.filter(run => run.userMessageEventId === event.id).sort(orderAttempts);
    turns.push({
      id: event.id,
      content: event.payload.content,
      sequence: event.sequence,
      attempts: attempts.map(run => ({
        id: run.id,
        clientMessageId: run.clientMessageId,
        retryOfRunId: run.retryOfRunId,
        status: run.status,
        deadline: run.deadline,
        outcome: safeOutcome(run.outcome),
      })),
    });
  }
  return conversationSnapshotSchema.parse({
    conversationId: history.conversation.id,
    revision: conversationRevision(history.runs.length, history.events.at(-1)?.sequence ?? 0),
    turns,
  });
}
