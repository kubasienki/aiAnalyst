import "server-only";
import type { ConversationMessage } from "../../shared/chat";

export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatModel {
  complete(messages: ModelMessage[], signal: AbortSignal): Promise<string>;
}

export type ChatErrorCode = "configuration" | "provider" | "timeout" | "cancelled";

export class ChatError extends Error {
  constructor(public readonly code: ChatErrorCode, message: string) {
    super(message);
    this.name = "ChatError";
  }
}

const SYSTEM_PROMPT = `You are a helpful ecommerce analytics assistant for a nontechnical user.
Explain concepts clearly and concisely. You currently have no tools or access to the dataset.
Never invent analytical results, claim to have queried data, or reuse unsupported numbers from conversation history.
When asked for actual results, explain that querying is not connected yet. You can discuss the question and the analysis needed.
The planned data source is the public GA4 ecommerce demo, covering November 1, 2020 through January 31, 2021.`;

export function createChatService(model: ChatModel) {
  return async function reply(messages: ConversationMessage[], signal: AbortSignal): Promise<string> {
    return model.complete([{ role: "system", content: SYSTEM_PROMPT }, ...messages], signal);
  };
}
