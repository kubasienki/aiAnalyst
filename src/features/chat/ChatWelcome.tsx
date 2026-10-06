import styles from "./chat.module.css";

const EXAMPLE_QUESTIONS = [
  "How did revenue change from November to December?",
  "Which devices generated the most revenue?",
  "What were the top-selling products in January 2021?",
];

export function ChatWelcome({ onSelect }: { onSelect: (question: string) => void }) {
  return (
    <div className={styles.welcome}>
      <p className={styles.eyebrow}>Explore your store’s performance</p>
      <h2>Start with a question.</h2>
      <p>Ask about revenue, products, or customers. Follow up to explore a different angle.</p>
      <p className={styles.dataset}>This demo uses historical GA4 ecommerce data from November 2020 through January 2021.</p>
      <div className={styles.examples}>
        {EXAMPLE_QUESTIONS.map((question) => (
          <button key={question} className={styles.exampleButton} onClick={() => onSelect(question)}>
            {question}<span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
    </div>
  );
}
