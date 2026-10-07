import "server-only";
import { z } from "zod";
import type { ModelRequest } from "../agent/contracts";
import { ContextError, type ContextBudget, type ContextMeasurement, type ModelRequestMeasurer } from "./contracts";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_SAFETY_TOKENS = 2_048;

const budgetSchema = z.strictObject({
  contextWindowTokens: z.number().int().positive().safe(),
  safetyTokens: z.number().int().nonnegative().safe(),
}).refine(budget => budget.safetyTokens < budget.contextWindowTokens);

const measurementSchema = z.strictObject({
  requestBytes: z.number().int().nonnegative().safe(),
  estimatedInputTokens: z.number().int().nonnegative().safe(),
  estimator: z.string().min(1),
});

// This operation is also the preflight boundary for each future runner request.
export function measureContextRequest(
  request: ModelRequest,
  measurer: ModelRequestMeasurer,
  budget: ContextBudget,
): ContextMeasurement {
  const parsedBudget = budgetSchema.safeParse(budget);
  if (!parsedBudget.success || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0
    || request.maxOutputTokens >= budget.contextWindowTokens - budget.safetyTokens) {
    throw new ContextError("configuration", "The context allowance must exceed output and safety reservations.");
  }
  const measured = measurementSchema.safeParse(measurer.measure(request));
  if (!measured.success) {
    throw new ContextError("configuration", "The request measurer returned invalid measurements.");
  }
  const remainingInputTokens = budget.contextWindowTokens - budget.safetyTokens
    - request.maxOutputTokens - measured.data.estimatedInputTokens;
  if (remainingInputTokens < 0) {
    throw new ContextError("context_limit", "The complete conversation exceeds the configured model input allowance.");
  }
  return {
    ...measured.data,
    contextWindowTokens: budget.contextWindowTokens,
    outputReservationTokens: request.maxOutputTokens,
    safetyReservationTokens: budget.safetyTokens,
    remainingInputTokens,
  };
}
