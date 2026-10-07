import { z } from "zod";
import { analysisOutcomeSchema } from "./analysis";
import { MAX_USER_MESSAGE_LENGTH } from "./chat";
import { chartDisplayResultSchema, MAX_ANSWER_CHARTS } from "./charts";

export const revisionSchema = z.string().regex(/^v1:\d+:\d+$/);
export const messageSubmissionSchema = z.strictObject({
  message: z.string().trim().min(1).max(MAX_USER_MESSAGE_LENGTH),
  clientMessageId: z.uuid(),
  expectedRevision: revisionSchema,
});
export const retrySubmissionSchema = messageSubmissionSchema.omit({ message: true });
export const failureCodeSchema = z.enum([
  "configuration", "provider", "protocol", "timeout", "cancelled", "deadline",
  "budget_exhausted", "context_limit", "persistence", "interrupted", "internal",
]);
export const failureOutcomeSchema = z.strictObject({
  kind: z.literal("failure"),
  status: z.enum(["failed", "cancelled", "interrupted"]),
  error: z.strictObject({ code: failureCodeSchema, message: z.string().min(1).max(2_000) }),
});
export const displayOutcomeSchema = z.union([analysisOutcomeSchema, failureOutcomeSchema]);
export const runStatusSchema = z.enum([
  "running", "completed", "waiting_for_user", "failed", "cancelled", "interrupted",
]);

// The status an attempt must carry for a given outcome. Persistence and display
// both enforce this, so it is defined once here rather than in each validator.
export function outcomeStatus(outcome: z.infer<typeof displayOutcomeSchema> | null): z.infer<typeof runStatusSchema> {
  if (outcome === null) {
    return "running";
  }
  if (outcome.kind === "answer") {
    return "completed";
  }
  if (outcome.kind === "clarification") {
    return "waiting_for_user";
  }
  return outcome.status;
}

export const attemptSchema = z.strictObject({
  id: z.uuid(),
  clientMessageId: z.uuid(),
  retryOfRunId: z.uuid().nullable(),
  status: runStatusSchema,
  deadline: z.number().int().nonnegative().safe(),
  outcome: displayOutcomeSchema.nullable(),
  // Display-only data is derived from evidence, never persisted or replayed.
  renderedCharts: z.array(chartDisplayResultSchema).max(MAX_ANSWER_CHARTS).optional(),
}).superRefine((attempt, context) => {
  if (attempt.status !== outcomeStatus(attempt.outcome)) {
    context.addIssue({ code: "custom", message: "Attempt status does not match its outcome." });
  }
});
export const conversationSnapshotSchema = z.strictObject({
  conversationId: z.uuid(),
  revision: revisionSchema,
  turns: z.array(z.strictObject({
    id: z.uuid(),
    content: z.string().min(1).max(MAX_USER_MESSAGE_LENGTH),
    sequence: z.number().int().positive().safe(),
    attempts: z.array(attemptSchema),
  })),
});
export const apiErrorSchema = z.strictObject({
  code: z.enum([
    "invalid_input", "not_found", "stale_revision", "active_run", "invalid_retry",
    "submission_mismatch", "unavailable", "internal", "synchronization_failed",
  ]),
  message: z.string().min(1).max(2_000),
});
export const apiErrorResponseSchema = z.strictObject({ error: apiErrorSchema });
export const submissionResponseSchema = z.strictObject({
  runId: z.uuid(),
  snapshot: conversationSnapshotSchema,
});
const executionEventFields = {
  runId: z.uuid(),
  snapshot: conversationSnapshotSchema,
};
export const chatStreamEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accepted"), ...executionEventFields }),
  z.strictObject({ kind: z.literal("progress"), runId: z.uuid(), phase: z.enum(["thinking", "querying"]) }),
  z.strictObject({ kind: z.literal("answer"), ...executionEventFields }),
  z.strictObject({ kind: z.literal("clarification"), ...executionEventFields }),
  z.strictObject({
    kind: z.literal("error"),
    runId: z.uuid(),
    snapshot: conversationSnapshotSchema.optional(),
    error: apiErrorSchema.optional(),
  }),
]);

export type MessageSubmission = z.infer<typeof messageSubmissionSchema>;
export type RetrySubmission = z.infer<typeof retrySubmissionSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type DisplayAttempt = z.infer<typeof attemptSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type SubmissionResponse = z.infer<typeof submissionResponseSchema>;

export function conversationRevision(runCount: number, lastEventSequence: number): string {
  return `v1:${runCount}:${lastEventSequence}`;
}

export function isOlderRevision(incoming: string, current: string): boolean {
  const incomingParts = incoming.split(":");
  const currentParts = current.split(":");
  return Number(incomingParts[1]) < Number(currentParts[1])
    || Number(incomingParts[2]) < Number(currentParts[2]);
}
