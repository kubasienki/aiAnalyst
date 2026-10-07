"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import styles from "./view.module.css";

const runListSchema = z.strictObject({ runs: z.array(z.object({
  id: z.string(), conversationId: z.string(), status: z.string(), createdAt: z.number(),
  finishedAt: z.number().nullable(), retryOfRunId: z.string().nullable(), versions: z.unknown(),
  outcome: z.unknown().nullable(), userEvent: z.unknown().nullable(),
})) });
const debugRunSchema = z.object({
  run: z.record(z.string(), z.unknown()),
  events: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(z.record(z.string(), z.unknown())),
  traces: z.array(z.record(z.string(), z.unknown())),
  contextCapture: z.string(),
});
type DebugRun = z.infer<typeof debugRunSchema>;

function displayTime(value: unknown): string {
  if (typeof value !== "number") return "—";
  return new Date(value).toLocaleString();
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export default function AgentDebugView() {
  const [runs, setRuns] = useState<z.infer<typeof runListSchema>["runs"]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<DebugRun | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/debug/agents", { cache: "no-store" })
      .then(async response => {
        const parsed = runListSchema.safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Could not read local agent runs.");
        if (active) {
          setRuns(parsed.data.runs);
          setSelectedRunId(current => current || parsed.data.runs[0]?.id || "");
        }
      })
      .catch(() => { if (active) setError("Unable to read the local SQLite database. Start the app once to initialize its schema."); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let active = true;
    fetch("/api/debug/agents/" + selectedRunId, { cache: "no-store" })
      .then(async response => {
        const parsed = debugRunSchema.safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Could not read run detail.");
        if (active) setRunDetail(parsed.data);
      })
      .catch(() => { if (active) setError("Unable to load this run."); });
    return () => { active = false; };
  }, [selectedRunId]);

  const run = runs.find(item => item.id === selectedRunId);
  const tokenCounts = runDetail?.traces.reduce<{ input: number; output: number }>((total, trace) => {
    const payload = recordValue(trace.payload);
    const usage = recordValue(payload?.usage);
    if (trace.kind !== "model_call" || !usage) return total;
    return {
      input: total.input + (typeof usage.inputTokens === "number" ? usage.inputTokens : 0),
      output: total.output + (typeof usage.outputTokens === "number" ? usage.outputTokens : 0),
    };
  }, { input: 0, output: 0 });

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Local development tool</p><h1>Agent flow debugger</h1>
        <p>Raw model calls, tool activity, conversation events, and query evidence from SQLite.</p></div>
      <Link href="/">Back to analyst</Link>
    </header>
    {error ? <div className={styles.error}>{error}</div> : null}
    <div className={styles.layout}>
      <aside className={styles.runList}>
        <h2>Recent runs <span>{runs.length}</span></h2>
        {runs.length === 0 && !error ? <p className={styles.muted}>No runs stored yet.</p> : null}
        {runs.map(item => {
          const message = recordValue(item.userEvent)?.content;
          return <button key={item.id} className={styles.runButton + (selectedRunId === item.id ? " " + styles.selected : "")} onClick={() => { setSelectedRunId(item.id); setRunDetail(null); }}>
            <strong>{item.status}</strong><time>{displayTime(item.createdAt)}</time>
            <span>{typeof message === "string" ? message : item.id}</span>
            <small>{item.id}</small>
          </button>;
        })}
      </aside>
      <section className={styles.detail}>
        {!runDetail ? <p className={styles.muted}>Choose a run to inspect its trace.</p> : <>
          <div className={styles.runHeading}><div><h2>{run?.status} run</h2><code>{selectedRunId}</code></div>
            <div className={styles.metrics}><span>Started<strong>{displayTime(run?.createdAt)}</strong></span><span>Duration<strong>{run?.finishedAt ? String(run.finishedAt - (run?.createdAt ?? run.finishedAt)) + " ms" : "running"}</strong></span><span>Tokens<strong>{tokenCounts ? String(tokenCounts.input) + " in / " + String(tokenCounts.output) + " out" : "not reported"}</strong></span></div>
          </div>
          <p className={styles.notice}>{runDetail.contextCapture}</p>
          <details open><summary>Run metadata and original submission</summary><pre>{pretty(runDetail.run)}</pre></details>
          <h3>Execution timeline</h3>
          {runDetail.traces.map(trace => <details className={styles.trace} key={String(trace.id)} open>
            <summary><span className={trace.kind === "model_call" ? styles.modelTag : styles.toolTag}>{String(trace.kind)}</span> <time>{displayTime(trace.startedAt)}</time> <span>{typeof trace.finishedAt === "number" && typeof trace.startedAt === "number" ? String(trace.finishedAt - trace.startedAt) + " ms" : "in progress"}</span></summary>
            <pre>{pretty(trace.payload)}</pre>
          </details>)}
          <details><summary>Stored conversation events ({runDetail.events.length})</summary>{runDetail.events.map(event => {
            const payload = recordValue(event.payload);
            return <details className={styles.nested} key={String(event.id)}><summary>#{String(event.sequence)} · {String(payload?.kind ?? "event")} · {displayTime(event.createdAt)}</summary><pre>{pretty(event.payload)}</pre></details>;
          })}</details>
          <details><summary>Query evidence ({runDetail.evidence.length})</summary>{runDetail.evidence.map(item => <details className={styles.nested} key={String(item.id)}><summary>{String(item.id)} · {displayTime(item.createdAt)}</summary><pre>{pretty(item.data)}</pre></details>)}</details>
        </>}
      </section>
    </div>
  </main>;
}
