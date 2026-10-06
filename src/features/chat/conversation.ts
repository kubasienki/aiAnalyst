import { MAX_CHAT_CONTENT_LENGTH, MAX_CHAT_MESSAGES } from "../../shared/chat";
import type { ChatMessage } from "./types";

export function appendUserMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  // Reserve one slot for the upcoming reply. Unanswered questions remain in history.
  return [...messages.slice(-(MAX_CHAT_MESSAGES - 2)), message];
}

export function selectChatContext(messages: ChatMessage[]): ChatMessage[] {
  let context = messages.slice(-(MAX_CHAT_MESSAGES - 1));
  let totalLength = context.reduce((sum, message) => sum + message.content.length, 0);

  // Drop oldest messages within the budget, then discard any orphan assistant reply.
  // Consecutive user messages are valid after a failure, so don't assume fixed pairs.
  while (context.length > 1 && totalLength > MAX_CHAT_CONTENT_LENGTH) {
    totalLength -= context[0].content.length;
    context = context.slice(1);
  }
  while (context[0]?.role === "assistant") {
    context = context.slice(1);
  }
  return context;
}
