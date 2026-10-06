import "server-only";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { createContextBuilder } from "../context/builder";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_SAFETY_TOKENS } from "../context/budget";
import { ContextError, type ContextBudget } from "../context/contracts";
import { readOpenRouterConfig } from "./openrouter";

export function readContextBudget(environment: Record<string, string | undefined> = process.env): ContextBudget {
  const raw = environment.AGENT_CONTEXT_WINDOW_TOKENS?.trim();
  const contextWindowTokens = raw ? Number(raw) : DEFAULT_CONTEXT_WINDOW_TOKENS;
  if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens <= DEFAULT_SAFETY_TOKENS + 4_096) {
    throw new ContextError("configuration", "AGENT_CONTEXT_WINDOW_TOKENS must be an integer greater than 6144.");
  }
  return { contextWindowTokens, safetyTokens: DEFAULT_SAFETY_TOKENS };
}

export function createContext() {
  const config = readOpenRouterConfig();
  return createContextBuilder({
    measurer: createOpenRouterRequestMeasurer(config.model),
    budget: readContextBudget(),
  });
}
