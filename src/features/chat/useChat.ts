import { useEffect, useState } from "react";
import { loadConversation, saveConversation } from "./storage";
import { MAX_MESSAGE_LENGTH, MAX_SAVED_MESSAGES, type ChatMessage } from "./types";

const PREVIEW_RESPONSE = "The analysis service isn’t connected yet, so I can’t answer this question. You can try the conversation flow here while the backend is being built.";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [conversationKey, setConversationKey] = useState(0);

  useEffect(() => {
    // Restore browser-only state after mounting to keep hydration consistent.
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      setMessages(loadConversation());
    } catch {
      setStorageError("Saved history couldn’t be loaded. You can start a new conversation.");
    }
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  function updateConversation(next: ChatMessage[]) {
    setMessages(next);
    try {
      saveConversation(next);
      setStorageError(null);
    } catch {
      setStorageError("History couldn’t be saved. You can keep chatting, but changes may be lost on reload.");
    }
  }

  function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!ready || !trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return;
    const next: ChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content: trimmed },
      { id: crypto.randomUUID(), role: "assistant", content: PREVIEW_RESPONSE },
    ];
    updateConversation(next.slice(-MAX_SAVED_MESSAGES));
  }

  function resetConversation() {
    updateConversation([]);
    setConversationKey((key) => key + 1);
  }

  return { messages, ready, storageError, conversationKey, sendMessage, resetConversation };
}
