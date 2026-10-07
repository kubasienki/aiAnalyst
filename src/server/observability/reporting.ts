import "server-only";
import { createExecutionScope, executionStopReason, ExecutionStopped } from "../execution/scope";

export const TRACE_WAIT_MS = 100;
export type TraceFailure = "trace_failed" | "trace_timeout";

export function reportSafely<T>(report: ((diagnostic: T) => void) | undefined, diagnostic: T): void {
  try {
    report?.(diagnostic);
  } catch {
    // Diagnostics must not change execution or prevent recovery.
  }
}

type TraceCapture = {
  signal: AbortSignal;
  deadline: number;
  write(signal: AbortSignal): Promise<void>;
  reportFailure?(category: TraceFailure): void;
};

// Bounds waiting, not a synchronous SQLite lock wait. Writers must check the
// supplied signal before accessing a repository after an asynchronous operation.
export async function captureTrace(input: TraceCapture): Promise<void> {
  if (executionStopReason(input.signal, input.deadline)) {
    return;
  }
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const scope = createExecutionScope(signal, Math.min(input.deadline, Date.now() + TRACE_WAIT_MS));
  try {
    await scope.wait(input.write(scope.signal));
  } catch (error) {
    if (!executionStopReason(input.signal, input.deadline)) {
      reportSafely(input.reportFailure, error instanceof ExecutionStopped ? "trace_timeout" : "trace_failed");
    }
  } finally {
    // Invalidate late writers even when a failed callback scheduled more work.
    lifetime.abort();
    scope.dispose();
  }
}
