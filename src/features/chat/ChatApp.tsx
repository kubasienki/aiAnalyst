"use client";

import { useEffect, useRef } from "react";
import { ChatComposer } from "./ChatComposer";
import { ChatMessages } from "./ChatMessages";
import { ChatWelcome } from "./ChatWelcome";
import { useChat } from "./useChat";
import { canRetry } from "./controller";
import styles from "./chat.module.css";

export function ChatApp() {
  const { state, controller } = useChat();
  const endRef = useRef<HTMLDivElement>(null);
  const disabled = state.phase !== "ready" || state.recovery !== null || !state.online;
  const snapshot = state.snapshot;
  let indication: string | null = null;
  if (state.phase === "loading") {
    indication = "Loading conversation…";
  } else if (state.phase === "reconnecting") {
    indication = "Reconnecting…";
  } else if (state.phase === "running" || state.phase === "submitting") {
    indication = state.progress === "querying" ? "Querying data…" : "Thinking…";
  }

  useEffect(() => {
    if (snapshot?.turns.length) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [snapshot?.revision, snapshot?.turns.length]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>HockeyStack</p>
          <h1>Ecommerce analyst</h1>
        </div>
        <button className={styles.secondaryButton} onClick={() => { void controller.newConversation(); }}>
          New conversation
        </button>
      </header>
      <p className={styles.notice}>AI analyst · Conversations are saved on this server. Relevant history and query evidence are sent to the AI provider.</p>
      <section className={styles.conversation} aria-label="Conversation">
        {snapshot && snapshot.turns.length > 0 && (
          <ChatMessages snapshot={snapshot} onChoice={choice => { void controller.sendMessage(choice); }} disabled={disabled} />
        )}
        {snapshot && snapshot.turns.length === 0 && !disabled && (
          <ChatWelcome onSelect={question => { void controller.sendMessage(question); }} />
        )}
        {indication && <p role="status">{indication}</p>}
        <div ref={endRef} />
      </section>
      <footer className={styles.footer}>
        {state.storageError && <p className={styles.storageError} role="status">{state.storageError}</p>}
        {state.error && <p className={styles.storageError} role="alert">{state.error}</p>}
        {state.phase === "reconnecting" && (
          <button className={styles.secondaryButton} onClick={() => { void controller.sync(); }}>Check status</button>
        )}
        {state.recovery && (
          <div className={styles.recovery}>
            <p role="status">This submission was not saved. You can resend it or review it first.</p>
            <button className={styles.secondaryButton} onClick={() => { void controller.resend(); }}>Resend submission</button>
            <button className={styles.secondaryButton} onClick={controller.reviewRecovery}>Review before sending</button>
          </div>
        )}
        {!disabled && canRetry(snapshot) && (
          <button className={styles.secondaryButton} onClick={() => { void controller.retry(); }}>Retry analysis</button>
        )}
        <ChatComposer key={state.conversationKey} draft={state.draft} onDraftChange={controller.setDraft}
          onSend={() => { void controller.sendMessage(); }} disabled={disabled} />
        <p className={styles.caption}>GA4 demo dataset · Nov 1, 2020 – Jan 31, 2021</p>
      </footer>
    </main>
  );
}
