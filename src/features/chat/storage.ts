import { MAX_MESSAGE_LENGTH, MAX_SAVED_MESSAGES, type ChatMessage } from "./types";
import { MAX_ASSISTANT_MESSAGE_LENGTH } from "../../shared/chat";

const STORAGE_KEY = "hockeystack.chat.v1";

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" && message.id.length <= 100 &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" && message.content.length <= (
      message.role === "assistant" ? MAX_ASSISTANT_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH
    )
  );
}

export function loadConversation(): ChatMessage[] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  const value: unknown = JSON.parse(saved);
  if (!Array.isArray(value) || value.length > MAX_SAVED_MESSAGES || !value.every(isMessage)) {
    throw new Error("Invalid saved conversation");
  }
  return value;
}

export function saveConversation(messages: ChatMessage[]) {
  if (!messages.length) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES)));
}
