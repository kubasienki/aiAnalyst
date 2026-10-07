import { z } from "zod";

const description = z.string().trim().min(1).max(1_000);
const periodSchema = z.strictObject({
  start: z.iso.date(),
  end: z.iso.date(),
}).refine(period => period.start <= period.end, {
  message: "The period start must precede or equal its end.",
});

// Accepted metadata is an interpretation of events, not verified query scope.
export const analysisMetadataSchema = z.strictObject({
  version: z.literal(1),
  context: z.strictObject({
    question: description,
    intent: z.enum(["analysis", "diagnosis", "methodology", "presentation"]),
    period: periodSchema.nullable(),
    comparisonPeriod: periodSchema.nullable(),
    filters: z.array(description).max(8),
    population: description,
    followupMode: z.enum(["new", "continue", "refine", "methodology", "presentation"]),
  }),
  findings: z.array(z.strictObject({
    statement: description,
    evidenceIds: z.array(z.uuid()).min(1).max(12),
    interpretation: description,
  })).max(6),
  openQuestions: z.array(z.strictObject({
    question: description,
    canInvestigate: z.boolean(),
    requiredForAnswer: z.boolean(),
    obstacle: description.nullable(),
  })).max(4),
});

export type AnalysisMetadata = z.infer<typeof analysisMetadataSchema>;
