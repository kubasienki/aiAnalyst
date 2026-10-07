import { z } from "zod";

const timestamp = z.number().int().nonnegative().safe();
const identity = z.uuid();

// Validate the inspection envelope, not arbitrary diagnostic JSON inside it.
// Malformed persisted JSON is deliberately returned as an inspection marker.
export const debugRunSummarySchema = z.strictObject({
  id: identity,
  conversationId: identity,
  status: z.string(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
  retryOfRunId: identity.nullable(),
  versions: z.unknown(),
  outcome: z.unknown(),
  userEvent: z.unknown(),
});

export const debugRunMetadataSchema = debugRunSummarySchema.omit({ userEvent: true }).extend({
  userMessageEventId: identity,
  deadline: timestamp,
  requestJson: z.string(),
  versionsJson: z.string(),
  outcomeJson: z.string().nullable(),
  request: z.unknown(),
});

export const debugEventSchema = z.strictObject({
  id: identity,
  sequence: z.number().int().positive().safe(),
  payloadVersion: z.number().int().positive().safe(),
  payloadJson: z.string(),
  createdAt: timestamp,
  payload: z.unknown(),
});

export const debugEvidenceSchema = z.strictObject({
  id: identity,
  payloadJson: z.string(),
  createdAt: timestamp,
  data: z.unknown(),
});

export const debugTraceSchema = z.strictObject({
  id: identity,
  sequence: z.number().int().positive().safe(),
  kind: z.enum(["model_call", "tool_call"]),
  payloadJson: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  payload: z.unknown(),
});

export const debugRunListSchema = z.strictObject({ runs: z.array(debugRunSummarySchema) });
export const debugRunSchema = z.strictObject({
  run: debugRunMetadataSchema,
  events: z.array(debugEventSchema),
  evidence: z.array(debugEvidenceSchema),
  traces: z.array(debugTraceSchema),
  contextCapture: z.string(),
});

export type DebugRunSummary = z.infer<typeof debugRunSummarySchema>;
export type DebugRun = z.infer<typeof debugRunSchema>;
export type DebugTrace = z.infer<typeof debugTraceSchema>;
