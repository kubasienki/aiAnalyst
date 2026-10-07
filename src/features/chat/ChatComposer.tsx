import type { FormEvent, KeyboardEvent } from "react";
import { MAX_USER_MESSAGE_LENGTH } from "../../shared/chat";
import styles from "./chat.module.css";

type ChatComposerProps = {
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onCancel: () => void;
  inputDisabled: boolean;
  canSend: boolean;
  requestActive: boolean;
  cancelling: boolean;
};

export function ChatComposer({ draft, onDraftChange, onSend, onCancel, inputDisabled, canSend, requestActive, cancelling }: ChatComposerProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || requestActive || !draft.trim()) {
      return;
    }
    // Acceptance, rather than clicking Send, clears the draft.
    onSend();
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
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="How did revenue change from November to December?"
        maxLength={MAX_USER_MESSAGE_LENGTH}
        rows={3}
        disabled={inputDisabled}
        aria-describedby="composer-hint"
      />
      <div className={styles.composerActions}>
        <span id="composer-hint">Enter to send · Shift + Enter for a new line</span>
        {requestActive ? (
          <button
            className={`${styles.primaryButton} ${styles.cancelButton}`}
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            aria-label={cancelling ? "Cancelling response" : "Cancel response"}
            title={cancelling ? "Cancelling response" : "Cancel response"}
          >
            <span className={styles.stopIcon} aria-hidden="true" />
          </button>
        ) : (
          <button className={styles.primaryButton} type="submit" disabled={!canSend || !draft.trim()}>Send</button>
        )}
      </div>
    </form>
  );
}
