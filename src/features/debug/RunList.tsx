import type { DebugRunSummary } from "../../shared/agent-debug";
import { displayTime, recordValue } from "./presentation";
import styles from "./debug.module.css";

type Props = {
  runs: DebugRunSummary[];
  selectedRunId: string;
  error: string;
  onSelect(runId: string): void;
};

export function RunList({ runs, selectedRunId, error, onSelect }: Props) {
  return (
    <aside className={styles.runList}>
      <h2>Recent runs <span>{runs.length}</span></h2>
      {runs.length === 0 && !error && <p className={styles.muted}>No runs stored yet.</p>}
      {runs.map(run => {
        const content = recordValue(run.userEvent)?.content;
        const message = typeof content === "string" ? content : run.id;
        const selectedClass = selectedRunId === run.id ? styles.selected : "";
        return (
          <button key={run.id} className={`${styles.runButton} ${selectedClass}`} onClick={() => onSelect(run.id)}>
            <strong>{run.status}</strong>
            <time>{displayTime(run.createdAt)}</time>
            <span>{message}</span>
            <small>{run.id}</small>
          </button>
        );
      })}
    </aside>
  );
}
