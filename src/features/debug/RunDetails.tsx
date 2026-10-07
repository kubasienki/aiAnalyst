import type { DebugRun, DebugRunSummary } from "../../shared/agent-debug";
import { displayTime, pretty, recordValue, totalReportedTokens } from "./presentation";
import styles from "./debug.module.css";

type Props = { detail: DebugRun; summary: DebugRunSummary | undefined };

export function RunDetails({ detail, summary }: Props) {
  const tokens = totalReportedTokens(detail.traces);
  const tokenText = tokens ? `${tokens.input} in / ${tokens.output} out` : "not reported";
  const duration = summary?.finishedAt === null || summary === undefined
    ? "running"
    : `${summary.finishedAt - summary.createdAt} ms`;
  return (
    <>
      <div className={styles.runHeading}>
        <div><h2>{summary?.status} run</h2><code>{detail.run.id}</code></div>
        <div className={styles.metrics}>
          <span>Started<strong>{displayTime(summary?.createdAt)}</strong></span>
          <span>Duration<strong>{duration}</strong></span>
          <span>Tokens<strong>{tokenText}</strong></span>
        </div>
      </div>
      <p className={styles.notice}>{detail.contextCapture}</p>
      <details open>
        <summary>Run metadata and original submission</summary>
        <pre>{pretty(detail.run)}</pre>
      </details>
      <h3>Execution timeline</h3>
      {detail.traces.map(trace => (
        <details className={styles.trace} key={trace.id} open>
          <summary>
            <span className={trace.kind === "model_call" ? styles.modelTag : styles.toolTag}>{trace.kind}</span>{" "}
            <time>{displayTime(trace.startedAt)}</time>{" "}
            <span>{trace.finishedAt === null ? "in progress" : `${trace.finishedAt - trace.startedAt} ms`}</span>
          </summary>
          <pre>{pretty(trace.payload)}</pre>
        </details>
      ))}
      <details>
        <summary>Stored conversation events ({detail.events.length})</summary>
        {detail.events.map(event => (
          <details className={styles.nested} key={event.id}>
            <summary>#{event.sequence} · {String(recordValue(event.payload)?.kind ?? "event")} · {displayTime(event.createdAt)}</summary>
            <pre>{pretty(event.payload)}</pre>
          </details>
        ))}
      </details>
      <details>
        <summary>Query evidence ({detail.evidence.length})</summary>
        {detail.evidence.map(evidence => (
          <details className={styles.nested} key={evidence.id}>
            <summary>{evidence.id} · {displayTime(evidence.createdAt)}</summary>
            <pre>{pretty(evidence.data)}</pre>
          </details>
        ))}
      </details>
    </>
  );
}
