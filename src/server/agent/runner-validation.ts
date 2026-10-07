import "server-only";
import { z } from "zod";
import { externalIdentifierSchema } from "../contracts/identity";
import { jsonValueSchema } from "../contracts/json";
import { assistantMessageSchema, modelMessageSchema, type ModelMessage, type ModelResponse, type RegisteredTool } from "./contracts";
import { inspectMessageSequence } from "./message-sequence";
import { AgentRunnerError } from "./runner-contracts";

export const limitsSchema = z.strictObject({
  maxModelRequests: z.number().int().positive().safe(),
  maxOutputTokens: z.number().int().positive().safe(),
});

const descriptionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  description: z.string().min(1),
  parameters: z.record(z.string(), jsonValueSchema).refine(parameters => parameters.type === "object"),
  role: z.enum(["continuing", "terminal"]),
});

const tokenCount = z.number().int().nonnegative().safe();
const responseSchema = z.strictObject({
  message: assistantMessageSchema,
  finishReason: z.enum(["stop", "tool_calls"]),
  requestId: externalIdentifierSchema.optional(),
  usage: z.strictObject({
    inputTokens: tokenCount, outputTokens: tokenCount,
    cachedInputTokens: tokenCount.optional(), reasoningTokens: tokenCount.optional(),
  }).optional(),
}).refine(response => (response.finishReason === "tool_calls") === (response.message.toolCalls.length > 0));

export function validateResponse(value: ModelResponse): ModelResponse {
  const result = responseSchema.safeParse(value);
  if (!result.success) {
    throw new AgentRunnerError("protocol", "The model returned an invalid action envelope.");
  }
  return result.data;
}

export function validateInitialMessages(messages: ModelMessage[]): ModelMessage[] {
  const parsed = z.array(modelMessageSchema).min(1).safeParse(messages);
  if (!parsed.success) {
    throw new AgentRunnerError("configuration", "The initial model messages are invalid.");
  }
  const sequence = inspectMessageSequence(parsed.data);
  if (!sequence.valid || sequence.pendingCallIds.size > 0) {
    throw new AgentRunnerError("configuration", "The initial history contains unmatched or unfinished tool calls.");
  }
  return parsed.data;
}

export function createToolRegistry<TContext, TOutcome, TArtifact>(tools: RegisteredTool<TContext, TOutcome, TArtifact>[]) {
  const registry = new Map<string, RegisteredTool<TContext, TOutcome, TArtifact>>();
  for (const tool of tools) {
    const parsed = descriptionSchema.safeParse(tool);
    if (!parsed.success || registry.has(tool.name)) {
      throw new AgentRunnerError("configuration", "Tool definitions must be valid and have unique names.");
    }
    registry.set(tool.name, { ...tool, ...parsed.data });
  }
  if (![...registry.values()].some(tool => tool.role === "terminal")) {
    throw new AgentRunnerError("configuration", "An agent attempt requires a terminal tool.");
  }
  return registry;
}
