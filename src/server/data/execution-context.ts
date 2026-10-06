import { DataQueryError } from "./errors";
import type { ExecutionContext } from "./types";

type ExecutionOptions = {
  signal?: AbortSignal;
  // Absolute deadline in milliseconds since the Unix epoch.
  deadline?: number;
};

export function createExecutionContext(options: ExecutionOptions = {}): ExecutionContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    deadline: options.deadline ?? Date.now() + 120_000,
    budget: {
      attemptsUsed: 0,
      maxAttempts: 4,
      resultBytesUsed: 0,
      maxResultBytes: 1024 * 1024,
    },
  };
}

export function checkExecution(context: ExecutionContext): void {
  if (context.signal.aborted) {
    throw new DataQueryError("cancelled", "Query execution was cancelled.");
  }
  if (Date.now() >= context.deadline) {
    throw new DataQueryError("deadline", "The execution deadline was reached.");
  }
}

// Bounds the caller's wait; it does not cancel the underlying SDK request.
export function withinDeadline<T>(work: Promise<T>, context: ExecutionContext): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      context.signal.removeEventListener("abort", onAbort);
      action();
    }

    function onAbort(): void {
      finish(() => reject(new DataQueryError("cancelled", "Query execution was cancelled.")));
    }

    const deadlineTimer = setTimeout(() => {
      finish(() => reject(new DataQueryError("deadline", "The execution deadline was reached.")));
    }, Math.max(0, context.deadline - Date.now()));

    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) {
      onAbort();
    }

    // Both handlers remain attached if cancellation wins, so late rejections
    // are consumed. finish ensures every path removes our timer and listener once.
    work.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}
