import type { ChatMessage } from "./types";
import styles from "./chat.module.css";

export function ChatMessages({ messages }: { messages: ChatMessage[] }) {
  return (
    <div role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" className={styles.messages}>
      {messages.map((message) => (
        <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
          <p className={styles.messageAuthor}>{message.role === "user" ? "You" : "Analyst"}</p>
          <p className={styles.messageContent}>{message.content}</p>
        </article>
      ))}
    </div>
  );
}
