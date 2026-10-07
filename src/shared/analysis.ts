import { z } from "zod";
import { MAX_ASSISTANT_MESSAGE_LENGTH } from "./chat";

const nonemptyText = z.string().trim().min(1);

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
