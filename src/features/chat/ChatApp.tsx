"use client";

import { useEffect, useRef } from "react";
import { ChatComposer } from "./ChatComposer";
import { ChatMessages } from "./ChatMessages";
import { ChatWelcome } from "./ChatWelcome";
import { useChat } from "./useChat";
import styles from "./chat.module.css";

export function ChatApp() {
  const { messages, ready, storageError, pending, chatError, conversationKey, sendMessage, retryMessage, resetConversation } = useChat();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>HockeyStack</p>
          <h1>Ecommerce analyst</h1>
        </div>
        <button className={styles.secondaryButton} onClick={resetConversation} disabled={!ready}>
          New conversation
        </button>
      </header>

      <p className={styles.notice}>AI chat · Data querying is not connected yet. Recent history is sent to the AI provider and saved in this browser.</p>

      <section className={styles.conversation} aria-label="Conversation">
        {!ready ? <p role="status">Loading conversation…</p> : messages.length ? (
          <ChatMessages messages={messages} />
        ) : <ChatWelcome onSelect={sendMessage} />}
        {pending && <p role="status">Thinking…</p>}
        <div ref={endRef} />
      </section>

      <footer className={styles.footer}>
        {storageError && <p className={styles.storageError} role="status">{storageError}</p>}
        {chatError && <p className={styles.storageError} role="alert">{chatError}</p>}
        {!pending && messages.at(-1)?.role === "user" && (
          <button className={styles.secondaryButton} onClick={retryMessage}>Retry reply</button>
        )}
        <ChatComposer key={conversationKey} onSend={sendMessage} disabled={!ready || pending} />
        <p className={styles.caption}>GA4 demo dataset · Nov 1, 2020 – Jan 31, 2021</p>
      </footer>
    </main>
  );
}
