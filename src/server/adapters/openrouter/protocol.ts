import "server-only";
import { z } from "zod";
import { isRecord } from "../../../shared/chat";
import {
  assistantMessageSchema, modelMessageSchema, providerReplaySchema,
  type ModelMessage, type ModelRequest, type ModelResponse, type ProviderReplay,
} from "../../agent/contracts";
import { inspectMessageSequence } from "../../agent/message-sequence";
import { ModelError } from "../../agent/errors";
import { jsonValueSchema } from "../../contracts/json";
import { safeIdentifier, type CompletionEnvelope } from "./transport";

const toolDescriptionSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  description: z.string().min(1),
  parameters: z.record(z.string(), jsonValueSchema).refine(schema => schema.type === "object"),
});

const requestSchema = z.strictObject({
  messages: z.array(modelMessageSchema).min(1),
  tools: z.array(toolDescriptionSchema),
  toolSelection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("required") }),
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("specific"), name: z.string().min(1) }),
  ]),
  maxOutputTokens: z.number().int().positive().safe(),
  deadline: z.number().int().nonnegative().safe(),
});

function invalidRequest(): never {
  throw new ModelError("invalid_request", "The model request is invalid.");
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: JSON.stringify(message.content) };
  }
  if (message.role !== "assistant") {
    return { role: message.role, content: message.content };
  }
  const result: Record<string, unknown> = { role: "assistant", content: message.content };
  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map(call => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  const replay = message.providerReplay;
  // Structured blocks can contain opaque signatures; never reconstruct them from text.
  if (replay?.reasoningDetails && replay.reasoningDetails.length > 0) {
    result.reasoning_details = replay.reasoningDetails;
  } else if (replay?.reasoning !== undefined) {
    result.reasoning = replay.reasoning;
  } else if (replay?.reasoningDetails !== undefined) {
    result.reasoning_details = replay.reasoningDetails;
  }
  return result;
}

export function serializeRequest(request: ModelRequest, model: string): Record<string, unknown> & { model: string } {
  const { signal, ...input } = request;
  if (!(signal instanceof AbortSignal)) {
    invalidRequest();
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    invalidRequest();
  }
  const validated = parsed.data;
  const toolNames = new Set(validated.tools.map(tool => tool.name));
  if (toolNames.size !== validated.tools.length) {
    invalidRequest();
  }
  if (validated.toolSelection.kind === "required" && toolNames.size === 0) {
    invalidRequest();
  }
  if (validated.toolSelection.kind === "specific" && !toolNames.has(validated.toolSelection.name)) {
    invalidRequest();
  }
  const sequence = inspectMessageSequence(validated.messages);
  if (!sequence.valid || sequence.pendingCallIds.size > 0) {
    invalidRequest();
  }

  const replayProviders = new Set<string>();
  let replayModel: string | undefined;
  for (const message of validated.messages) {
    if (message.role !== "assistant" || !message.providerReplay) {
      continue;
    }
    const origin = message.providerReplay.origin;
    if ((origin.requestedModel ?? origin.model) !== model) {
      throw new ModelError("replay_mismatch", "Stored reasoning belongs to a different model.");
    }
    if (replayModel !== undefined && replayModel !== origin.model) {
      throw new ModelError("replay_mismatch", "Stored reasoning belongs to conflicting resolved models.");
    }
    replayModel = origin.model;
    if (origin.provider) {
      replayProviders.add(origin.provider);
    }
  }
  if (replayProviders.size > 1) {
    throw new ModelError("replay_mismatch", "Stored reasoning belongs to conflicting providers.");
  }
  const provider: Record<string, unknown> = { require_parameters: true };
  if (replayProviders.size === 1) {
    provider.only = [...replayProviders];
    provider.allow_fallbacks = false;
  }
  let toolChoice: unknown = validated.toolSelection.kind;
  if (validated.toolSelection.kind === "specific") {
    toolChoice = { type: "function", function: { name: validated.toolSelection.name } };
  }
  return {
    // Router aliases can choose a different model on each call. Opaque reasoning
    // must return to the concrete model that produced it.
    model: replayModel ?? model,
    messages: validated.messages.map(serializeMessage),
    tools: validated.tools.map(tool => ({ type: "function", function: tool })),
    tool_choice: toolChoice,
    parallel_tool_calls: false,
    provider,
    stream: false,
    max_tokens: validated.maxOutputTokens,
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readUsage(value: unknown): ModelResponse["usage"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = nonnegativeInteger(value.prompt_tokens);
  const outputTokens = nonnegativeInteger(value.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: isRecord(value.prompt_tokens_details)
      ? nonnegativeInteger(value.prompt_tokens_details.cached_tokens) : undefined,
    reasoningTokens: isRecord(value.completion_tokens_details)
      ? nonnegativeInteger(value.completion_tokens_details.reasoning_tokens) : undefined,
  };
}

function readReplay(
  payload: Record<string, unknown>,
  message: Record<string, unknown>,
  requestedModel: string,
  sentModel: string,
): ProviderReplay | undefined {
  const reasoning = message.reasoning ?? undefined;
  const reasoningDetails = message.reasoning_details ?? undefined;
  if (reasoning === undefined && reasoningDetails === undefined) {
    return undefined;
  }
  return providerReplaySchema.parse({
    origin: {
      model: typeof payload.model === "string" && payload.model ? payload.model : sentModel,
      requestedModel,
      provider: typeof payload.provider === "string" && payload.provider ? payload.provider : undefined,
    },
    reasoning,
    reasoningDetails,
  });
}

export function normalizeResponse(
  envelope: CompletionEnvelope,
  requestedModel: string,
  sentModel: string = requestedModel,
): ModelResponse {
  const { payload, choice } = envelope;
  try {
    const finishReason = choice.finish_reason;
    if (finishReason !== "stop" && finishReason !== "tool_calls") {
      throw new Error("Unsupported completion");
    }
    const rawMessage = choice.message;
    if (!isRecord(rawMessage) || rawMessage.role !== "assistant") {
      throw new Error("Invalid assistant message");
    }
    const calls = rawMessage.tool_calls ?? [];
    if (!Array.isArray(calls)) {
      throw new Error("Invalid tool calls");
    }
    const toolCalls = calls.map(call => {
      if (!isRecord(call) || call.type !== "function" || !isRecord(call.function)) {
        throw new Error("Invalid function call");
      }
      return { callId: call.id, name: call.function.name, argumentsJson: call.function.arguments };
    });
    if ((finishReason === "tool_calls") !== (toolCalls.length > 0)) {
      throw new Error("Completion and calls disagree");
    }
    const message = assistantMessageSchema.parse({
      role: "assistant",
      content: rawMessage.content ?? null,
      toolCalls,
      providerReplay: readReplay(payload, rawMessage, requestedModel, sentModel),
    });
    return {
      message,
      finishReason,
      requestId: envelope.requestId ?? safeIdentifier(payload.id),
      usage: readUsage(payload.usage),
    };
  } catch {
    throw new ModelError("invalid_response", "The AI provider returned an invalid reply. Please retry.");
  }
}
