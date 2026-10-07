import { Fragment } from "react";
import type { ConversationSnapshot, DisplayAttempt } from "../../shared/conversations";
import styles from "./chat.module.css";

type Props = {
  snapshot: ConversationSnapshot;
  onChoice: (choice: string) => void;
  disabled: boolean;
};

function AttemptOutcome({ attempt, choicesEnabled, onChoice }: {
  attempt: DisplayAttempt;
  choicesEnabled: boolean;
  onChoice: (choice: string) => void;
}) {
  const outcome = attempt.outcome;
  if (!outcome) {
    return null;
  }
  if (outcome.kind === "failure") {
    return <p className={styles.storageError}>{outcome.error.message}</p>;
  }
  return (
    <article className={`${styles.message} ${styles.assistantMessage}`}>
      <p className={styles.messageAuthor}>Analyst</p>
      {outcome.kind === "clarification" ? (
        <>
          <p className={styles.messageContent}>{outcome.clarification.question}</p>
          {choicesEnabled && outcome.clarification.choices && (
            <div className={styles.choices}>
              {outcome.clarification.choices.map(choice => (
                <button key={choice} className={styles.secondaryButton} onClick={() => onChoice(choice)}>{choice}</button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {outcome.answer.completeness === "partial" && <p className={styles.messageAuthor}>Partial answer</p>}
          <p className={styles.messageContent}>{outcome.answer.narrative}</p>
          {outcome.answer.assumptions.length > 0 && (
            <div className={styles.answerDetails}>
              <p>Assumptions</p>
              <ul>{outcome.answer.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul>
            </div>
          )}
          {outcome.answer.limitations.length > 0 && (
            <div className={styles.answerDetails}>
              <p>Limitations</p>
              <ul>{outcome.answer.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </article>
  );
}

export function ChatMessages({ snapshot, onChoice, disabled }: Props) {
  const latest = snapshot.turns.at(-1)?.attempts.at(-1);
  return (
    <div role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" className={styles.messages}>
      {snapshot.turns.map(turn => (
        <Fragment key={turn.id}>
          <article className={`${styles.message} ${styles.userMessage}`}>
            <p className={styles.messageAuthor}>You</p>
            <p className={styles.messageContent}>{turn.content}</p>
          </article>
          {turn.attempts.map(attempt => (
            <AttemptOutcome key={attempt.id} attempt={attempt} onChoice={onChoice}
              choicesEnabled={!disabled && attempt.id === latest?.id} />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
