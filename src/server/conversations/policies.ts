import "server-only";
import { canonicalJson } from "../contracts/json-equality";
import type { ConversationEvent, ConversationRun } from "./contracts";
import type { FinishRunInput } from "./repository";

export type PolicyConflictReason = "stale_revision" | "active_run" | "invalid_retry";

export class ConversationPolicyViolation extends Error {
  constructor(message: string, public readonly reason?: PolicyConflictReason) {
    super(message);
    this.name = "ConversationPolicyViolation";
  }
}

type AdmissionSnapshot = {
  expectedRevision: string;
  currentRevision: string;
  deadline: number;
  now: number;
  hasActiveRun: boolean;
};

// The adapter supplies facts read under its writer lock; this module performs no I/O.
export function assertRunAdmission(snapshot: AdmissionSnapshot): void {
  if (snapshot.expectedRevision !== snapshot.currentRevision) {
    throw new ConversationPolicyViolation("Conversation changed. Review the refreshed history before sending.", "stale_revision");
  }
  if (snapshot.deadline <= snapshot.now) {
    throw new ConversationPolicyViolation("A new run needs a future deadline.");
  }
  if (snapshot.hasActiveRun) {
    throw new ConversationPolicyViolation("This conversation already has an active run.", "active_run");
  }
}

type RetrySnapshot = {
  source: ConversationRun;
  conversationId: string;
  latestRunId: string | undefined;
  hasActiveRun: boolean;
};

export function assertRetryEligibility(snapshot: RetrySnapshot): void {
  if (snapshot.source.conversationId !== snapshot.conversationId) {
    throw new ConversationPolicyViolation("The retried run belongs to another conversation.", "invalid_retry");
  }
  if (!["failed", "cancelled", "interrupted"].includes(snapshot.source.status)) {
    throw new ConversationPolicyViolation("Only a failed, cancelled, or interrupted run can be retried.", "invalid_retry");
  }
  if (snapshot.hasActiveRun) {
    throw new ConversationPolicyViolation("This conversation already has an active run.", "active_run");
  }
  if (snapshot.latestRunId !== snapshot.source.id) {
    throw new ConversationPolicyViolation("Only the latest attempt can be retried.", "invalid_retry");
  }
}

type FinalizationSnapshot = {
  run: ConversationRun;
  events: ConversationEvent[];
  requested: FinishRunInput;
};

export function checkRunFinalization({ run, events, requested }: FinalizationSnapshot): "already_finished" | "finish" {
  if (run.status !== "running") {
    if (canonicalJson(run.outcome) !== canonicalJson(requested.outcome)) {
      throw new ConversationPolicyViolation("The run already has a different terminal outcome.");
    }
    const acknowledgment = requested.acknowledgment;
    if (acknowledgment && !events.some(event => event.payload.kind === "tool_result"
      && canonicalJson(event.payload.result) === canonicalJson(acknowledgment))) {
      throw new ConversationPolicyViolation("The terminal acknowledgment differs from the stored result.");
    }
    return "already_finished";
  }
  if (requested.outcome.kind === "failure") {
    return "finish";
  }
  const acknowledgment = requested.acknowledgment;
  if (!acknowledgment || acknowledgment.payload.kind !== "inline") {
    throw new ConversationPolicyViolation("An analytical outcome needs an inline terminal-tool acknowledgment.");
  }
  const calls = events.flatMap(event => event.payload.kind === "assistant_message" ? event.payload.message.toolCalls : []);
  const terminalCall = calls.find(call => call.callId === acknowledgment.callId);
  if (!terminalCall) {
    throw new ConversationPolicyViolation("Tool result has no matching call in this run.");
  }
  const expectedTool = requested.outcome.kind === "answer" ? "finish_answer" : "request_clarification";
  if (terminalCall.name !== expectedTool) {
    throw new ConversationPolicyViolation("The terminal tool does not match the outcome.");
  }
  const resolved = new Set(events.flatMap(event => event.payload.kind === "tool_result" ? [event.payload.result.callId] : []));
  resolved.add(acknowledgment.callId);
  if (calls.some(call => !resolved.has(call.callId))) {
    throw new ConversationPolicyViolation("An analytical outcome cannot leave unfinished tool calls.");
  }
  return "finish";
}
