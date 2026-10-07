import "server-only";
import { z } from "zod";
import { identitySchema } from "../contracts/identity";
import { jsonValueSchema } from "../contracts/json";
import {
  MAX_RESULT_PAYLOAD_BYTES, MAX_RESULT_ROWS,
  type QueryColumn, type QueryEvidence,
} from "../data/types";

// A query result plus the analyst's declarations about it. The analysis context
// produces this, conversations persist it, and the context builder projects it
// for the model; it is defined here so none of them depends on another.

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
  rows: z.array(z.record(z.string(), jsonValueSchema)).max(MAX_RESULT_ROWS),
  payloadBytes: z.number().int().nonnegative().max(MAX_RESULT_PAYLOAD_BYTES),
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

// Database ownership fields stay outside the model payload.
export const storedEvidenceSchema = evidenceInputSchema.extend({
  conversationId: identitySchema,
  runId: identitySchema,
  createdAt: z.number().int().nonnegative().safe(),
});

export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export type StoredEvidence = z.infer<typeof storedEvidenceSchema>;
