import { useEffect, useRef, useState } from "react";
import { requestChatReply } from "./chat-api";
import { appendUserMessage } from "./conversation";
import { loadConversation, saveConversation } from "./storage";
import { MAX_MESSAGE_LENGTH, MAX_SAVED_MESSAGES, type ChatMessage } from "./types";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [conversationKey, setConversationKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

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

  useEffect(() => () => activeRequest.current?.abort(), []);

  function updateConversation(next: ChatMessage[]) {
    setMessages(next);
    try {
      saveConversation(next);
      setStorageError(null);
    } catch {
      setStorageError("History couldn’t be saved. You can keep chatting, but changes may be lost on reload.");
    }
  }

  async function completeConversation(next: ChatMessage[]) {
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setChatError(null);
    try {
      const content = await requestChatReply(next, controller.signal);
      // A reset can start a new conversation before an old request settles.
      if (activeRequest.current !== controller) return;
      const completed: ChatMessage[] = [
        ...next,
        { id: crypto.randomUUID(), role: "assistant", content },
      ];
      updateConversation(completed.slice(-MAX_SAVED_MESSAGES));
    } catch (error) {
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      setChatError(error instanceof Error ? error.message : "Chat failed. Please retry.");
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPending(false);
      }
    }
  }

  function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!ready || activeRequest.current || !trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return;
    const next = appendUserMessage(messages, {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    });
    updateConversation(next);
    void completeConversation(next);
  }

  function retryMessage() {
    if (!ready || activeRequest.current || messages.at(-1)?.role !== "user") return;
    void completeConversation(messages);
  }

  function resetConversation() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPending(false);
    setChatError(null);
    updateConversation([]);
    setConversationKey((key) => key + 1);
  }

  return { messages, ready, storageError, pending, chatError, conversationKey, sendMessage, retryMessage, resetConversation };
}
