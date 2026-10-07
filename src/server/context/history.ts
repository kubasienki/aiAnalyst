import "server-only";
import { inspectMessageSequence } from "../agent/message-sequence";
import { transcriptSequence } from "../conversations/transcript";
import type { ConversationEvent, ConversationRun } from "../conversations/contracts";
import type { ConversationHistory } from "../conversations/repository";
import { ContextError, type HistoryInteraction, type ReconstructedHistory } from "./contracts";

// The repository decodes every row and enforces run admission, retry eligibility,
// event order and tool-call pairing when it writes. Reconstruction only checks what
// it needs to build a valid provider transcript from that history.

function invalidHistory(): never {
  throw new ContextError("invalid_history", "The conversation history is inconsistent.");
}

function reconstructRun(run: ConversationRun, events: ConversationEvent[]): HistoryInteraction[] {
  if (!inspectMessageSequence(transcriptSequence(events)).valid) {
    invalidHistory();
  }
  const interactions: HistoryInteraction[] = [];
  const seenCallIds = new Set<string>();
  let pending: HistoryInteraction | undefined;
  const pendingIds = new Set<string>();

  for (const event of events) {
    const payload = event.payload;
    if (payload.kind === "tool_result") {
      if (!pending || !pendingIds.delete(payload.result.callId)) {
        invalidHistory();
      }
      pending.events.push(event);
      if (pendingIds.size === 0) {
        pending.complete = true;
        pending = undefined;
      }
      continue;
    }
    if (payload.kind === "outcome") {
      if (pending && payload.outcome.kind !== "failure") {
        invalidHistory();
      }
      interactions.push({ runId: run.id, kind: "outcome", events: [event], complete: true });
      continue;
    }
    if (pending) {
      invalidHistory();
    }
    if (payload.kind === "user_message") {
      interactions.push({ runId: run.id, kind: "user", events: [event], complete: true });
      continue;
    }
    if (payload.kind === "context_note") {
      interactions.push({ runId: run.id, kind: "note", events: [event], complete: true });
      continue;
    }
    const calls = payload.message.toolCalls;
    for (const call of calls) {
      if (seenCallIds.has(call.callId)) {
        invalidHistory();
      }
      seenCallIds.add(call.callId);
      pendingIds.add(call.callId);
    }
    const interaction: HistoryInteraction = {
      runId: run.id,
      kind: calls.length > 0 ? "tool_interaction" : "assistant",
      events: [event],
      complete: calls.length === 0,
    };
    interactions.push(interaction);
    if (calls.length > 0) {
      pending = interaction;
    }
  }
  return interactions;
}

function terminalOutcome(run: ConversationRun, events: ConversationEvent[]): [string, ConversationEvent] | undefined {
  if (!run.outcome || run.outcome.kind === "failure") {
    return undefined;
  }
  const outcomeEvent = events.at(-1);
  const acknowledgment = events.at(-2);
  if (!outcomeEvent || acknowledgment?.payload.kind !== "tool_result"
    || acknowledgment.payload.result.payload.kind !== "inline") {
    invalidHistory();
  }
  const expectedName = run.outcome.kind === "answer" ? "finish_answer" : "request_clarification";
  const callId = acknowledgment.payload.result.callId;
  const matches = events.some(event => event.payload.kind === "assistant_message"
    && event.payload.message.toolCalls.some(call => call.callId === callId && call.name === expectedName));
  if (!matches) {
    invalidHistory();
  }
  return [acknowledgment.id, outcomeEvent];
}

export function reconstructHistory(history: ConversationHistory, targetRunId: string): ReconstructedHistory {
  const runs = new Map(history.runs.map(run => [run.id, run]));
  const eventsById = new Map(history.events.map(event => [event.id, event]));
  const target = runs.get(targetRunId);
  if (!target || target.status !== "running") {
    invalidHistory();
  }

  // Runs are replayed in the order their events were written; the target run may
  // have no events yet and always comes last.
  const runEvents = new Map<string, ConversationEvent[]>();
  for (const event of [...history.events].sort((left, right) => left.sequence - right.sequence)) {
    const ownEvents = runEvents.get(event.runId) ?? [];
    ownEvents.push(event);
    runEvents.set(event.runId, ownEvents);
  }
  const orderedRuns = [...runEvents.keys()].filter(runId => runId !== targetRunId);
  orderedRuns.push(targetRunId);

  const interactions: HistoryInteraction[] = [];
  const terminalOutcomes = new Map<string, ConversationEvent>();
  for (const runId of orderedRuns) {
    const run = runs.get(runId);
    if (!run) {
      invalidHistory();
    }
    const ownEvents = runEvents.get(run.id) ?? [];
    // A retry reuses the original question, which is stored with the first attempt.
    if (run.retryOfRunId) {
      const userEvent = eventsById.get(run.userMessageEventId);
      if (!userEvent) {
        invalidHistory();
      }
      interactions.push({ runId: run.id, kind: "user", events: [userEvent], complete: true });
    }
    interactions.push(...reconstructRun(run, ownEvents));
    const terminal = terminalOutcome(run, ownEvents);
    if (terminal) {
      terminalOutcomes.set(...terminal);
    }
  }
  const evidence = new Map(history.evidence.map(record => [record.evidence.resultId, record]));
  return { interactions, runs, evidence, terminalOutcomes };
}
