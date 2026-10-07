import "server-only";
import { z } from "zod";
import { clarificationSchema, answerSchema } from "../../shared/analysis";

const nonemptyText = z.string().trim().min(1);

export const runSqlArgumentsSchema = z.strictObject({
  intent: nonemptyText.max(2_000).describe("Explain the question, date range, metric, filters, and expected row grain. This is a declaration, not proof of SQL correctness."),
  sql: nonemptyText.max(32 * 1024).refine(sql => Buffer.byteLength(sql, "utf8") <= 32 * 1024, {
    message: "SQL must fit 32 KiB of UTF-8.",
  }),
});

export const inspectDatasetArgumentsSchema = z.strictObject({
  topic: nonemptyText.max(300).describe("Name the business topic, event tag, parameter or field whose schema is needed."),
});

export { clarificationSchema, answerSchema, analysisOutcomeSchema } from "../../shared/analysis";
export type { AnalysisOutcome, Answer, Clarification } from "../../shared/analysis";

// Basis belongs to the tool invocation, keeping stored Answer outcomes compatible.
export const finishAnswerArgumentsSchema = answerSchema.safeExtend({
  basis: z.enum(["data", "explanation"]).describe("Use data for any finding about this dataset. Explanation is only for conceptual guidance without empirical claims."),
});

export const ANALYSIS_TOOL_DESCRIPTIONS = [
  {
    name: "inspect_dataset",
    description: "Look up known schema fields, event names/tags, parameter keys and definitions for an unfamiliar dataset topic. Static metadata only; makes no BigQuery query. The catalog is incomplete discovery guidance, never an allowlist.",
    parameters: z.toJSONSchema(inspectDatasetArgumentsSchema, { target: "draft-07" }),
  },
  {
    name: "run_sql",
    description: "Obtain evidence using guarded read-only BigQuery SQL. Declare intent first, then review returned SQL, scope, grain, units, rows, and completeness before using the evidence.",
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
    parameters: z.toJSONSchema(finishAnswerArgumentsSchema, { target: "draft-07" }),
  },
];
