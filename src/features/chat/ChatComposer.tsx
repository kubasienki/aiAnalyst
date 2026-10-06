import { useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_MESSAGE_LENGTH } from "./types";
import styles from "./chat.module.css";

type ChatComposerProps = { onSend: (message: string) => void; disabled: boolean };

export function ChatComposer({ onSend, disabled }: ChatComposerProps) {
  const [draft, setDraft] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    onSend(draft);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className={styles.composer} onSubmit={submit}>
      <label className={styles.inputLabel} htmlFor="chat-message">Ask about your data</label>
      <textarea
        id="chat-message"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="How did revenue change from November to December?"
        maxLength={MAX_MESSAGE_LENGTH}
        rows={3}
        disabled={disabled}
        aria-describedby="composer-hint"
      />
      <div className={styles.composerActions}>
        <span id="composer-hint">Enter to send · Shift + Enter for a new line</span>
        <button className={styles.primaryButton} type="submit" disabled={disabled || !draft.trim()}>Send message</button>
      </div>
    </form>
  );
}
