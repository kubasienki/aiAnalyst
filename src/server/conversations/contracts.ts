import "server-only";
import { z } from "zod";
import { assistantMessageSchema } from "../agent/contracts";
import { analysisOutcomeSchema } from "../analysis/contracts";
import { jsonValueSchema } from "../contracts/json";
import type { QueryColumn, QueryEvidence } from "../data/types";

export const identitySchema = z.uuid();
const timestampSchema = z.number().int().nonnegative().safe();
const queryColumnSchema: z.ZodType<QueryColumn> = z.lazy(() => z.strictObject({
  name: z.string().min(1),
  type: z.string().min(1),
  mode: z.string().optional(),
  fields: z.array(queryColumnSchema).optional(),
}));

export const queryEvidenceSchema: z.ZodType<QueryEvidence> = z.strictObject({
  resultId: identitySchema,
  sql: z.string().min(1),
  columns: z.array(queryColumnSchema),
  rows: z.array(z.record(z.string(), jsonValueSchema)).max(200),
  payloadBytes: z.number().int().nonnegative().max(256 * 1024),
  truncated: z.boolean(),
  truncationReason: z.enum(["row_limit", "byte_limit"]).optional(),
  jobId: z.string().min(1),
  estimatedBytes: z.string().regex(/^\d+$/),
  statistics: z.strictObject({
    bytesProcessed: z.string().regex(/^\d+$/),
    bytesBilled: z.string().regex(/^\d+$/),
    cacheHit: z.boolean(),
  }),
  elapsedMs: z.number().nonnegative(),
  semanticGuideVersion: z.string().min(1),
}).refine(evidence => evidence.truncated === Boolean(evidence.truncationReason), {
  message: "Truncation metadata is inconsistent.",
}).refine(evidence => Buffer.byteLength(JSON.stringify({ columns: evidence.columns, rows: evidence.rows }), "utf8") === evidence.payloadBytes, {
  message: "Evidence payload size does not match its columns and rows.",
});

export const evidenceInputSchema = z.strictObject({
  evidence: queryEvidenceSchema,
  semanticGuideSnapshot: z.string().min(1),
  // Analyst declarations are not a mechanically verified interpretation of SQL.
  declaredScope: z.record(z.string(), jsonValueSchema).optional(),
  assumptions: z.array(z.string().min(1)),
});

export const storedEvidenceSchema = evidenceInputSchema.extend({
  conversationId: identitySchema,
  runId: identitySchema,
  createdAt: timestampSchema,
});

export const runFailureSchema = z.strictObject({
  code: z.enum([
    "configuration", "provider", "protocol", "timeout", "cancelled", "deadline",
    "budget_exhausted", "context_limit", "persistence", "interrupted", "internal",
  ]),
  message: z.string().min(1).max(2_000),
});

export const runOutcomeSchema = z.union([
  analysisOutcomeSchema,
  z.strictObject({
    kind: z.literal("failure"),
    status: z.enum(["failed", "cancelled", "interrupted"]),
    error: runFailureSchema,
  }),
]);

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
  z.strictObject({
    kind: z.literal("user_message"),
    content: z.string().trim().min(1).max(2_000),
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

export const runStatusSchema = z.enum([
  "running", "completed", "waiting_for_user", "failed", "cancelled", "interrupted",
]);

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
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export type StoredEvidence = z.infer<typeof storedEvidenceSchema>;
export type RunVersions = z.infer<typeof runVersionsSchema>;

export function outcomeStatus(outcome: RunOutcome): z.infer<typeof runStatusSchema> {
  if (outcome.kind === "answer") {
    return "completed";
  }
  if (outcome.kind === "clarification") {
    return "waiting_for_user";
  }
  return outcome.status;
}
