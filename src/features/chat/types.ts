import { MAX_CHAT_MESSAGES, MAX_USER_MESSAGE_LENGTH, type ConversationMessage } from "../../shared/chat";

export type ChatMessage = ConversationMessage & {
  id: string;
};

export const MAX_MESSAGE_LENGTH = MAX_USER_MESSAGE_LENGTH;
export const MAX_SAVED_MESSAGES = MAX_CHAT_MESSAGES;
