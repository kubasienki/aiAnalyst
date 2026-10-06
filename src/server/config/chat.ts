import "server-only";
import { createOpenRouterChatModel } from "../adapters/openrouter/chat-model";
import { ChatError, createChatService } from "../chat/chat-service";
import { ModelError } from "../agent/errors";
import { readOpenRouterConfig } from "./openrouter";

export function createChat() {
  try {
    return createChatService(createOpenRouterChatModel(readOpenRouterConfig()));
  } catch (error) {
    if (error instanceof ModelError) {
      throw new ChatError("configuration", error.message);
    }
    throw error;
  }
}
