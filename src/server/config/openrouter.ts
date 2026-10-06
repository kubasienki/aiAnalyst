import "server-only";
import { ModelError } from "../agent/errors";
import { DEFAULT_MAX_RESPONSE_BYTES, type OpenRouterConfig } from "../adapters/openrouter/transport";

export function readOpenRouterConfig(
  environment: Record<string, string | undefined> = process.env,
): OpenRouterConfig {
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  const model = environment.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) {
    throw new ModelError("configuration", "Chat is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL on the server.");
  }
  const rawLimit = environment.OPENROUTER_MAX_RESPONSE_BYTES?.trim();
  const maxResponseBytes = rawLimit ? Number(rawLimit) : DEFAULT_MAX_RESPONSE_BYTES;
  if ((rawLimit && !/^\d+$/.test(rawLimit)) || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new ModelError("configuration", "OPENROUTER_MAX_RESPONSE_BYTES must be a positive integer in bytes.");
  }
  return { apiKey, model, maxResponseBytes };
}
