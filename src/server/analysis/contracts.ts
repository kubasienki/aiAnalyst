import "server-only";
import { z } from "zod";
import { clarificationSchema, answerSchema } from "../../shared/analysis";
import { answerChartsSchema } from "../../shared/charts";
import { analysisMetadataSchema } from "../../shared/analysis-metadata";

const nonemptyText = z.string().trim().min(1);

export const runSqlArgumentsSchema = z.strictObject({
  intent: nonemptyText.max(2_000).describe("Name the concrete question being tested, period/comparison, metric, important filters, population and expected row grain. State how the test advances the investigation. This declaration is not proof of SQL correctness."),
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
  analysis: analysisMetadataSchema.describe("Compact accepted interpretation, ranked evidence-backed findings and useful unanswered questions. Latest user corrections override prior interpretation. Required unresolved diagnostic questions block early finishing when further investigation is possible."),
  narrative: answerSchema.shape.narrative.describe("Lead with the direct answer. Explain supported findings and their business implications; quantify relevant comparisons and contributors when the question warrants investigation. Distinguish observations from hypotheses and disclose unresolved questions. Keep scalar answers concise; do not merely repeat chart values."),
  charts: answerChartsSchema.describe("Illustrate the main findings that benefit from at-a-glance visual understanding, even without an explicit chart request. New charts plus earlier charts referenced by exact title should adequately cover those findings. Choose the smallest set that achieves coverage, up to three charts. Supply [] only when visuals add no clarity, named earlier charts adequately cover the findings, the user requests no charts, or supported chart evidence is unavailable. Preserve valid charts when repairing another. Reference saved evidence and columns; never copy values or write rendering code."),
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
    description: "Finish with a direct conclusion, minimal supporting evidence and proportionate interpretation. Supply ranked evidence-backed findings and material open questions. Necessary dataset-investigable diagnostic questions require another test when possible; otherwise give a supported partial answer with the specific obstacle or limit. Include useful visual coverage of the main findings; mention exact earlier chart titles when relying on them and add charts for uncovered findings. Ends this run.",
    parameters: z.toJSONSchema(finishAnswerArgumentsSchema, { target: "draft-07" }),
  },
];
