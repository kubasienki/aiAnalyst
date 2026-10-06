import "server-only";
import { isRecord, MAX_ASSISTANT_MESSAGE_LENGTH } from "../../../shared/chat";
import { ModelError } from "../../agent/errors";
import { ChatError, type ChatModel } from "../../chat/chat-service";
import { createOpenRouterTransport, type OpenRouterConfig, type ReportFailure } from "./transport";

export type { OpenRouterDiagnostic } from "./transport";

export function createOpenRouterChatModel(
  config: OpenRouterConfig,
  fetcher: typeof fetch = fetch,
  reportFailure?: ReportFailure,
): ChatModel {
  const complete = createOpenRouterTransport(config, fetcher, reportFailure);
  return {
    async complete(messages, signal) {
      try {
        return await complete(
          { model: config.model, messages, stream: false, max_tokens: 2_000 },
          { signal },
          ({ choice }) => {
            if (choice.finish_reason !== "stop" || !isRecord(choice.message)) {
              throw new ModelError("invalid_response", "The AI provider returned an invalid reply. Please retry.");
            }
            const content = choice.message.content;
            if (typeof content !== "string" || !content.trim() || content.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
              throw new ModelError("invalid_response", "The AI provider returned an invalid reply. Please retry.");
            }
            return content.trim();
          },
        );
      } catch (error) {
        if (!(error instanceof ModelError)) {
          throw error;
        }
        if (error.code === "cancelled" || error.code === "timeout" || error.code === "configuration") {
          throw new ChatError(error.code, error.message);
        }
        throw new ChatError("provider", error.message);
      }
    },
  };
}
