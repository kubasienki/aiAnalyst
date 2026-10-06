import "server-only";
import { createOpenRouterChatModel } from "../adapters/openrouter/chat-model";
import { ChatError, createChatService } from "../chat/chat-service";

export function createChat() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) {
    throw new ChatError("configuration", "Chat is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL on the server.");
  }
  return createChatService(createOpenRouterChatModel({ apiKey, model }));
}
