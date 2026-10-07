import "server-only";
import { z } from "zod";
import { assistantMessageSchema } from "../agent/contracts";
import { analysisOutcomeSchema } from "../analysis/contracts";
import { failureOutcomeSchema, outcomeStatus, runStatusSchema } from "../../shared/conversations";
import { MAX_USER_MESSAGE_LENGTH } from "../../shared/chat";
import { jsonValueSchema } from "../contracts/json";
import { identitySchema } from "../contracts/identity";

// Persistence and the client contract share these: an attempt's status, the
// failure vocabulary, and the outcome-to-status rule are one definition.
export { outcomeStatus, runStatusSchema };
export { identitySchema };
export {
  queryEvidenceSchema, evidenceInputSchema, storedEvidenceSchema,
  type EvidenceInput, type StoredEvidence,
} from "../evidence/contracts";

const timestampSchema = z.number().int().nonnegative().safe();
export const runFailureSchema = failureOutcomeSchema.shape.error;

export const runOutcomeSchema = z.union([analysisOutcomeSchema, failureOutcomeSchema]);

export const storedToolResultSchema = z.strictObject({
  callId: z.string().min(1).max(200),
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("inline"), content: jsonValueSchema }),
    z.strictObject({ kind: z.literal("evidence"), evidenceId: identitySchema }),
    z.strictObject({
      kind: z.literal("evidence_unavailable"),
      evidenceId: identitySchema,
      content: jsonValueSchema,
    }),
  ]),
});

export const eventPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("context_note"), content: z.string().trim().min(1).max(2_000) }),
  z.strictObject({
    kind: z.literal("user_message"),
    content: z.string().trim().min(1).max(MAX_USER_MESSAGE_LENGTH),
  }),
  z.strictObject({ kind: z.literal("assistant_message"), message: assistantMessageSchema }),
  z.strictObject({ kind: z.literal("tool_result"), result: storedToolResultSchema }),
  z.strictObject({ kind: z.literal("outcome"), outcome: runOutcomeSchema }),
]);

export const conversationSchema = z.strictObject({
  id: identitySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const runVersionsSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.string().min(1),
  semanticGuide: z.string().min(1),
});

export const runSchema = z.strictObject({
  id: identitySchema,
  conversationId: identitySchema,
  userMessageEventId: identitySchema,
  clientMessageId: identitySchema,
  retryOfRunId: identitySchema.nullable(),
  status: runStatusSchema,
  deadline: timestampSchema,
  versions: runVersionsSchema,
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  outcome: runOutcomeSchema.nullable(),
}).superRefine((run, context) => {
  if (run.status === "running") {
    if (run.finishedAt !== null || run.outcome !== null) {
      context.addIssue({ code: "custom", message: "A running attempt cannot have a terminal outcome." });
    }
    return;
  }
  if (run.finishedAt === null || run.outcome === null || outcomeStatus(run.outcome) !== run.status) {
    context.addIssue({ code: "custom", message: "A terminal attempt needs a matching outcome and timestamp." });
  }
});

export const conversationEventSchema = z.strictObject({
  id: identitySchema,
  conversationId: identitySchema,
  runId: identitySchema,
  sequence: z.number().int().positive().safe(),
  payloadVersion: z.literal(1),
  payload: eventPayloadSchema,
  createdAt: timestampSchema,
});

export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRun = z.infer<typeof runSchema>;
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
export type EventPayload = z.infer<typeof eventPayloadSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type StoredToolResult = z.infer<typeof storedToolResultSchema>;
export type RunVersions = z.infer<typeof runVersionsSchema>;

