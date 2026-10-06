export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export const MAX_CHAT_MESSAGES = 40;
export const MAX_USER_MESSAGE_LENGTH = 2_000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 16_000;
export const MAX_CHAT_CONTENT_LENGTH = 64_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChatRequest(value: unknown): ConversationMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Expected a conversation.");
  }
  if (value.messages.length === 0 || value.messages.length > MAX_CHAT_MESSAGES) {
    throw new Error("Conversation must contain 1–40 messages.");
  }

  let totalLength = 0;
  const messages = value.messages.map((message: unknown): ConversationMessage => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      throw new Error("Invalid message role.");
    }
    const limit = message.role === "user" ? MAX_USER_MESSAGE_LENGTH : MAX_ASSISTANT_MESSAGE_LENGTH;
    if (typeof message.content !== "string" || !message.content.trim() || message.content.length > limit) {
      throw new Error("Invalid message content.");
    }
    totalLength += message.content.length;
    return { role: message.role, content: message.content };
  });

  if (totalLength > MAX_CHAT_CONTENT_LENGTH) {
    throw new Error("Conversation is too long. Start a new conversation.");
  }
  if (messages.at(-1)?.role !== "user") {
    throw new Error("The last message must be from the user.");
  }
  return messages;
}
