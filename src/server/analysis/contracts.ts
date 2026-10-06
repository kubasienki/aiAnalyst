import "server-only";
import { z } from "zod";
import { MAX_ASSISTANT_MESSAGE_LENGTH } from "../../shared/chat";

const nonemptyText = z.string().trim().min(1);

export const runSqlArgumentsSchema = z.strictObject({ sql: nonemptyText.max(64 * 1024) });

export const clarificationSchema = z.strictObject({
  question: nonemptyText.max(2_000),
  choices: z.array(nonemptyText.max(500)).min(2).max(5).optional(),
});

export const answerSchema = z.strictObject({
  narrative: nonemptyText.max(MAX_ASSISTANT_MESSAGE_LENGTH),
  assumptions: z.array(nonemptyText.max(2_000)).max(20),
  limitations: z.array(nonemptyText.max(2_000)).max(20),
  evidenceIds: z.array(z.uuid()).max(100),
  completeness: z.enum(["complete", "partial"]),
}).refine(answer => new Set(answer.evidenceIds).size === answer.evidenceIds.length, {
  message: "Evidence references must be unique.",
});

export const analysisOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), answer: answerSchema }),
  z.strictObject({ kind: z.literal("clarification"), clarification: clarificationSchema }),
]);

export type AnalysisOutcome = z.infer<typeof analysisOutcomeSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type Clarification = z.infer<typeof clarificationSchema>;

// Only descriptions and schemas are defined here; execution is a later stage.
export const ANALYSIS_TOOL_DESCRIPTIONS = [
  {
    name: "run_sql",
    description: "Obtain evidence using guarded read-only BigQuery SQL following the supplied semantic guide.",
    parameters: z.toJSONSchema(runSqlArgumentsSchema, { target: "draft-07" }),
  },
  {
    name: "request_clarification",
    description: "Ask a focused question when unresolved ambiguity materially changes the analysis. Ends this run.",
    parameters: z.toJSONSchema(clarificationSchema, { target: "draft-07" }),
  },
  {
    name: "finish_answer",
    description: "Finish with a supported narrative, assumptions, limitations, and evidence references. Ends this run.",
    parameters: z.toJSONSchema(answerSchema, { target: "draft-07" }),
  },
];
