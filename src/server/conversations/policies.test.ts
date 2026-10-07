import { describe, expect, it } from "vitest";
import type { ConversationEvent, ConversationRun, RunOutcome } from "./contracts";
import { assertRunAdmission, assertRetryEligibility, checkRunFinalization } from "./policies";

const run: ConversationRun = {
  id: "run", conversationId: "conversation", userMessageEventId: "user", clientMessageId: "submission",
  retryOfRunId: null, status: "running", deadline: 2000, createdAt: 1000, finishedAt: null, outcome: null,
  versions: { model: "model", prompt: "prompt", tools: "tools", semanticGuide: "guide" },
};
const failure: RunOutcome = { kind: "failure", status: "failed", error: { code: "provider", message: "Unavailable" } };
const clarification: RunOutcome = { kind: "clarification", clarification: { question: "Which period?" } };
const assistant: ConversationEvent = {
  id: "assistant", conversationId: run.conversationId, runId: run.id, sequence: 1, payloadVersion: 1, createdAt: 1000,
  payload: { kind: "assistant_message", message: {
    role: "assistant", content: null,
    toolCalls: [{ name: "request_clarification", callId: "clarify", argumentsJson: "{}" }],
  } },
};
const acknowledgment = { callId: "clarify", payload: { kind: "inline" as const, content: { accepted: true } } };

describe("conversation workflow policies", () => {
  it("requires a seen revision, future deadline, and no active run in that order", () => {
    const snapshot = { expectedRevision: "v1:0:0", currentRevision: "v1:0:0", deadline: 2000, now: 1000, hasActiveRun: false };
    expect(() => assertRunAdmission(snapshot)).not.toThrow();
    expect(() => assertRunAdmission({ ...snapshot, currentRevision: "v1:1:1", hasActiveRun: true })).toThrow(expect.objectContaining({ reason: "stale_revision" }));
    expect(() => assertRunAdmission({ ...snapshot, deadline: 1000 })).toThrow("future deadline");
    expect(() => assertRunAdmission({ ...snapshot, hasActiveRun: true })).toThrow(expect.objectContaining({ reason: "active_run" }));
  });

  it("allows only eligible latest attempts from the same idle conversation", () => {
    const source = { ...run, status: "failed" as const, outcome: failure, finishedAt: 1500 };
    const snapshot = { source, conversationId: run.conversationId, latestRunId: run.id, hasActiveRun: false };
    expect(() => assertRetryEligibility(snapshot)).not.toThrow();
    expect(() => assertRetryEligibility({ ...snapshot, conversationId: "other" })).toThrow(expect.objectContaining({ reason: "invalid_retry" }));
    expect(() => assertRetryEligibility({ ...snapshot, source: run })).toThrow("Only a failed");
    expect(() => assertRetryEligibility({ ...snapshot, latestRunId: "other" })).toThrow("latest attempt");
    expect(() => assertRetryEligibility({ ...snapshot, hasActiveRun: true })).toThrow(expect.objectContaining({ reason: "active_run" }));
  });

  it("requires matching terminal acknowledgment and resolved tools, but permits failure recovery", () => {
    const requested = { outcome: clarification, acknowledgment };
    expect(checkRunFinalization({ run, events: [assistant], requested })).toBe("finish");
    expect(() => checkRunFinalization({ run, events: [assistant], requested: { outcome: clarification } })).toThrow("acknowledgment");
    const unfinished: ConversationEvent = {
      ...assistant,
      payload: { kind: "assistant_message", message: {
        role: "assistant", content: null,
        toolCalls: [{ name: "run_sql", callId: "query", argumentsJson: "{}" }],
      } },
    };
    expect(() => checkRunFinalization({ run, events: [assistant, unfinished], requested })).toThrow("unfinished tool calls");
    expect(checkRunFinalization({ run, events: [unfinished], requested: { outcome: failure } })).toBe("finish");
    expect(() => checkRunFinalization({ run, events: [unfinished], requested: {
      outcome: clarification, acknowledgment: { ...acknowledgment, callId: "query" },
    } })).toThrow("does not match");
  });

  it("accepts equivalent repeated finalization and rejects a conflicting outcome", () => {
    const finished = { ...run, status: "waiting_for_user" as const, outcome: clarification, finishedAt: 1500 };
    const result: ConversationEvent = { ...assistant, payload: { kind: "tool_result", result: acknowledgment } };
    const equivalent: RunOutcome = { clarification: { question: "Which period?" }, kind: "clarification" };
    expect(checkRunFinalization({ run: finished, events: [result], requested: { outcome: equivalent, acknowledgment } })).toBe("already_finished");
    expect(() => checkRunFinalization({ run: finished, events: [result], requested: { outcome: failure } })).toThrow("different terminal outcome");
    expect(() => checkRunFinalization({ run: finished, events: [], requested: { outcome: equivalent, acknowledgment } })).toThrow("acknowledgment differs");
  });
});
