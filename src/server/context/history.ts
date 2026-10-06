import "server-only";
import { z } from "zod";
import {
  conversationSchema, conversationEventSchema, runSchema, storedEvidenceSchema,
  type ConversationEvent, type ConversationRun,
} from "../conversations/contracts";
import type { ConversationHistory } from "../conversations/repository";
import { ContextError, type HistoryInteraction, type ReconstructedHistory } from "./contracts";

const historySchema = z.strictObject({
  conversation: conversationSchema,
  runs: z.array(runSchema),
  events: z.array(conversationEventSchema),
  evidence: z.array(storedEvidenceSchema),
});

function invalidHistory(): never {
  throw new ContextError("invalid_history", "The conversation history is inconsistent.");
}

function uniqueRecords<T extends { id: string }>(records: T[]): Map<string, T> {
  const index = new Map(records.map(record => [record.id, record]));
  if (index.size !== records.length) {
    invalidHistory();
  }
  return index;
}

function validateRun(
  run: ConversationRun,
  events: ConversationEvent[],
  runs: Map<string, ConversationRun>,
  eventsById: Map<string, ConversationEvent>,
  eventsByRun: Map<string, ConversationEvent[]>,
): ConversationEvent {
  const userEvent = eventsById.get(run.userMessageEventId);
  if (!userEvent || userEvent.payload.kind !== "user_message") {
    invalidHistory();
  }
  if (run.retryOfRunId) {
    const source = runs.get(run.retryOfRunId);
    if (!source || source.id === run.id || source.userMessageEventId !== userEvent.id
      || !["failed", "cancelled", "interrupted"].includes(source.status)) {
      invalidHistory();
    }
    const sourceEnd = eventsByRun.get(source.id)?.at(-1);
    if (sourceEnd?.payload.kind !== "outcome" || (events[0] && sourceEnd.sequence >= events[0].sequence)
      || events.some(event => event.payload.kind === "user_message")) {
      invalidHistory();
    }
  } else if (userEvent.runId !== run.id || events[0]?.id !== userEvent.id
    || events.filter(event => event.payload.kind === "user_message").length !== 1) {
    invalidHistory();
  }
  const outcomes = events.filter(event => event.payload.kind === "outcome");
  if (run.status === "running") {
    if (outcomes.length !== 0) {
      invalidHistory();
    }
  } else {
    const last = events.at(-1);
    if (outcomes.length !== 1 || last?.payload.kind !== "outcome"
      || JSON.stringify(last.payload.outcome) !== JSON.stringify(run.outcome)) {
      invalidHistory();
    }
  }
  return userEvent;
}

function reconstructRun(run: ConversationRun, events: ConversationEvent[]): HistoryInteraction[] {
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

export function reconstructHistory(input: ConversationHistory, targetRunId: string): ReconstructedHistory {
  const parsed = historySchema.safeParse(input);
  if (!parsed.success) {
    invalidHistory();
  }
  const history = parsed.data;
  const runs = uniqueRecords(history.runs);
  const eventsById = uniqueRecords(history.events);
  const target = runs.get(targetRunId);
  if (!target || target.status !== "running") {
    invalidHistory();
  }
  const events = [...history.events].sort((left, right) => left.sequence - right.sequence);
  const runEvents = new Map<string, ConversationEvent[]>();
  const closedRuns = new Set<string>();
  let previousRunId: string | undefined;
  let previousSequence = 0;
  for (const event of events) {
    if (event.conversationId !== history.conversation.id || !runs.has(event.runId)
      || event.sequence <= previousSequence || closedRuns.has(event.runId)) {
      invalidHistory();
    }
    if (previousRunId && previousRunId !== event.runId) {
      closedRuns.add(previousRunId);
    }
    const ownEvents = runEvents.get(event.runId) ?? [];
    ownEvents.push(event);
    runEvents.set(event.runId, ownEvents);
    previousRunId = event.runId;
    previousSequence = event.sequence;
  }
  if (runEvents.has(targetRunId) && previousRunId !== targetRunId) {
    invalidHistory();
  }
  const orderedRuns = [...runEvents.keys()];
  if (!runEvents.has(targetRunId)) {
    orderedRuns.push(targetRunId);
  }
  if (orderedRuns.length !== runs.size) {
    invalidHistory();
  }

  const interactions: HistoryInteraction[] = [];
  const terminalOutcomes = new Map<string, ConversationEvent>();
  for (const runId of orderedRuns) {
    const run = runs.get(runId);
    if (!run || run.conversationId !== history.conversation.id
      || (run.id !== targetRunId && run.status === "running")) {
      invalidHistory();
    }
    const ownEvents = runEvents.get(run.id) ?? [];
    const userEvent = validateRun(run, ownEvents, runs, eventsById, runEvents);
    if (run.retryOfRunId) {
      interactions.push({ runId: run.id, kind: "user", events: [userEvent], complete: true });
    }
    interactions.push(...reconstructRun(run, ownEvents));
    const terminal = terminalOutcome(run, ownEvents);
    if (terminal) {
      terminalOutcomes.set(...terminal);
    }
  }
  const evidence = new Map(history.evidence.map(record => [record.evidence.resultId, record]));
  if (evidence.size !== history.evidence.length || history.evidence.some(record =>
    record.conversationId !== history.conversation.id || !runs.has(record.runId),
  )) {
    invalidHistory();
  }
  return { interactions, runs, evidence, terminalOutcomes };
}
