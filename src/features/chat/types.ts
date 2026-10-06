export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_SAVED_MESSAGES = 40;
