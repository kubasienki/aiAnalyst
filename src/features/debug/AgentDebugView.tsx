"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DebugRun, DebugRunSummary } from "../../shared/agent-debug";
import { createDebugApi } from "./debug-api";
import { RunList } from "./RunList";
import { RunDetails } from "./RunDetails";
import styles from "./debug.module.css";

export default function AgentDebugView() {
  const [api] = useState(() => createDebugApi());
  const [runs, setRuns] = useState<DebugRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<DebugRun | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function loadRuns() {
      try {
        const result = await api.list(controller.signal);
        if (!controller.signal.aborted) {
          setRuns(result);
          setSelectedRunId(current => current || result[0]?.id || "");
        }
      } catch {
        if (!controller.signal.aborted) {
          setError("Unable to read the local SQLite database. Start the app once to initialize its schema.");
        }
      }
    }
    void loadRuns();
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    const controller = new AbortController();
    async function loadDetail() {
      try {
        const result = await api.load(selectedRunId, controller.signal);
        if (!controller.signal.aborted) {
          setRunDetail(result);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted) {
          setError("Unable to load this run.");
        }
      }
    }
    void loadDetail();
    return () => controller.abort();
  }, [api, selectedRunId]);

  function selectRun(runId: string): void {
    if (runId === selectedRunId) {
      return;
    }
    setSelectedRunId(runId);
    setRunDetail(null);
    setError("");
  }

  const selectedRun = runs.find(run => run.id === selectedRunId);
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Local development tool</p>
          <h1>Agent flow debugger</h1>
          <p>Raw model calls, tool activity, conversation events, and query evidence from SQLite.</p>
        </div>
        <Link href="/">Back to analyst</Link>
      </header>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.layout}>
        <RunList runs={runs} selectedRunId={selectedRunId} error={error} onSelect={selectRun} />
        <section className={styles.detail}>
          {runDetail
            ? <RunDetails detail={runDetail} summary={selectedRun} />
            : <p className={styles.muted}>Choose a run to inspect its trace.</p>}
        </section>
      </div>
    </main>
  );
}
