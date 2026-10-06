import "server-only";
import { isRecord, MAX_ASSISTANT_MESSAGE_LENGTH } from "../../../shared/chat";
import { ChatError, type ChatModel } from "../../chat/chat-service";

type OpenRouterConfig = { apiKey: string; model: string };

type FailureCategory = "network" | "http" | "invalid_response" | "completion_error" | "truncated" | "filtered" | "timeout";

export type OpenRouterDiagnostic = {
  category: FailureCategory;
  model: string;
  status?: number;
  requestId?: string;
  providerCode?: number;
};

type ReportFailure = (diagnostic: OpenRouterDiagnostic) => void;

function logFailure(diagnostic: OpenRouterDiagnostic) {
  // Log only explicitly selected fields, never raw bodies, errors, prompts, or headers.
  console.error("OpenRouter chat failed", diagnostic);
}

function readRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id");
  if (value && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    return value;
  }
  return undefined;
}

function readProviderError(payload: unknown, choice: unknown): Record<string, unknown> | undefined {
  if (isRecord(payload) && isRecord(payload.error)) {
    return payload.error;
  }
  if (isRecord(choice) && isRecord(choice.error)) {
    return choice.error;
  }
  return undefined;
}

export function createOpenRouterChatModel(
  config: OpenRouterConfig,
  fetcher: typeof fetch = fetch,
  reportFailure: ReportFailure = logFailure,
): ChatModel {
  return {
    async complete(messages, signal) {
      // The timeout also covers reading the response body; aborting fetch stops local I/O.
      // A provider may still process a request after the caller disconnects.
      const timeout = AbortSignal.timeout(60_000);
      const requestSignal = AbortSignal.any([signal, timeout]);
      const diagnostic: OpenRouterDiagnostic = { category: "network", model: config.model };
      try {
        const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: config.model, messages, stream: false, max_tokens: 2_000 }),
          signal: requestSignal,
        });
        diagnostic.status = response.status;
        diagnostic.requestId = readRequestId(response);
        if (!response.ok) {
          diagnostic.category = "http";
          throw new ChatError("provider", "The AI provider could not complete the request. Please retry.");
        }

        diagnostic.category = "invalid_response";
        const payload: unknown = await response.json();
        const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
        const providerError = readProviderError(payload, choice);
        if (providerError || (isRecord(choice) && choice.finish_reason === "error")) {
          diagnostic.category = "completion_error";
          if (typeof providerError?.code === "number" && Number.isSafeInteger(providerError.code)) {
            diagnostic.providerCode = providerError.code;
          }
          throw new ChatError("provider", "The AI provider could not complete the reply. Please retry.");
        }
        if (isRecord(choice) && choice.finish_reason === "length") {
          diagnostic.category = "truncated";
          throw new ChatError("provider", "The AI reply reached its length limit. Try asking for a shorter answer.");
        }
        if (isRecord(choice) && choice.finish_reason === "content_filter") {
          diagnostic.category = "filtered";
          throw new ChatError("provider", "The AI provider could not return this reply. Try rephrasing your question.");
        }
        // This chat has no tools. Only a normally completed text reply is a success.
        if (!isRecord(choice) || choice.finish_reason !== "stop") {
          throw new ChatError("provider", "The AI provider returned an invalid reply. Please retry.");
        }
        const message = isRecord(choice.message) ? choice.message : undefined;
        const content = message?.content;
        if (typeof content !== "string" || !content.trim() || content.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
          throw new ChatError("provider", "The AI provider returned an invalid reply. Please retry.");
        }
        return content.trim();
      } catch (error) {
        if (signal.aborted) {
          throw new ChatError("cancelled", "The request was cancelled.");
        }
        if (timeout.aborted) {
          diagnostic.category = "timeout";
        }
        reportFailure(diagnostic);
        if (timeout.aborted) {
          throw new ChatError("timeout", "The AI response took too long. Please retry.");
        }
        if (error instanceof ChatError) {
          throw error;
        }
        // Raw provider errors can contain request headers or response details.
        throw new ChatError("provider", "The AI provider could not be reached. Please retry.");
      }
    },
  };
}
