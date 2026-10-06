import "server-only";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../contracts/json";

export const toolCallSchema = z.strictObject({
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  // Keep the original string: malformed arguments are part of the execution record.
  argumentsJson: z.string().max(64 * 1024),
});

export const providerReplaySchema = z.strictObject({
  origin: z.strictObject({
    model: z.string().min(1),
    requestedModel: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
  }),
  reasoning: z.string().optional(),
  // Provider blocks are intentionally not narrowed to one model's block types.
  // Preserve every field, signature, and block order for the adapter to replay.
  reasoningDetails: z.array(z.record(z.string(), jsonValueSchema)).optional(),
}).refine(replay => replay.reasoning !== undefined || replay.reasoningDetails !== undefined, {
  message: "Provider replay data needs reasoning or reasoning details.",
});

export const assistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().max(16_000).nullable(),
  toolCalls: z.array(toolCallSchema).max(16),
  // Server-owned protocol data; never include it in display messages or logs.
  // Response/context budgets belong to the adapter and context builder, not a field cap.
  providerReplay: providerReplaySchema.optional(),
}).superRefine((message, context) => {
  if (!message.content?.trim() && message.toolCalls.length === 0) {
    context.addIssue({ code: "custom", message: "An assistant message needs content or tool calls." });
  }
  const ids = message.toolCalls.map(call => call.callId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Tool-call IDs must be unique within a message." });
  }
});

export const toolMessageSchema = z.strictObject({
  role: z.literal("tool"),
  callId: z.string().min(1).max(200),
  content: jsonValueSchema,
});

export const modelMessageSchema = z.union([
  z.strictObject({ role: z.literal("system"), content: z.string().min(1) }),
  z.strictObject({ role: z.literal("user"), content: z.string().min(1).max(2_000) }),
  assistantMessageSchema,
  toolMessageSchema,
]);

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ProviderReplay = z.infer<typeof providerReplaySchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type ModelMessage = z.infer<typeof modelMessageSchema>;

export type ToolDescription = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolSelection =
  | { kind: "required" }
  | { kind: "none" }
  | { kind: "specific"; name: string };

export type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolDescription[];
  toolSelection: ToolSelection;
  maxOutputTokens: number;
  // Absolute run deadline in milliseconds since the Unix epoch.
  deadline: number;
  signal: AbortSignal;
};

export type ModelResponse = {
  message: AssistantMessage;
  finishReason: "stop" | "tool_calls";
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
};

export interface AgentModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ToolExecution<TOutcome> =
  | { kind: "continue"; content: JsonValue }
  | { kind: "terminal"; acknowledgment: JsonValue; outcome: TOutcome };

// A registered tool will close over its schema and validate unknown arguments.
// The runner never needs to cast heterogeneous tool arguments to a domain type.
export type RegisteredTool<TContext, TOutcome> = ToolDescription & {
  execute(argumentsValue: unknown, context: TContext): Promise<ToolExecution<TOutcome>>;
};

export type ToolDefinition<TArguments, TContext, TOutcome> = {
  name: string;
  description: string;
  argumentsSchema: z.ZodType<TArguments>;
  handle(argumentsValue: TArguments, context: TContext): Promise<ToolExecution<TOutcome>>;
};
