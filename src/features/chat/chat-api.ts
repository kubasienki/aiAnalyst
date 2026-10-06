import { isRecord, MAX_ASSISTANT_MESSAGE_LENGTH } from "../../shared/chat";
import { selectChatContext } from "./conversation";
import type { ChatMessage } from "./types";

export async function requestChatReply(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const context = selectChatContext(messages);
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: context.map(({ role, content }) => ({ role, content })) }),
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : "Chat failed. Please retry.";
    throw new Error(error);
  }
  if (!isRecord(payload) || typeof payload.content !== "string" || !payload.content.trim() || payload.content.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    throw new Error("Chat returned an invalid reply. Please retry.");
  }
  return payload.content;
}
