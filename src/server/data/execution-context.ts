import { DataQueryError } from "./errors";
import type { ExecutionContext } from "./types";

export function createExecutionContext(options: { signal?: AbortSignal; deadline?: number } = {}): ExecutionContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    deadline: options.deadline ?? Date.now() + 120_000,
    budget: { attemptsUsed: 0, maxAttempts: 4, resultBytesUsed: 0, maxResultBytes: 1024 * 1024 },
  };
}

export function checkExecution(context: ExecutionContext): void {
  if (context.signal.aborted) throw new DataQueryError("cancelled", "Query execution was cancelled.");
  if (Date.now() >= context.deadline) throw new DataQueryError("deadline", "The execution deadline was reached.");
}

// Bound the caller's wait even when an SDK request cannot itself be aborted.
export function withinDeadline<T>(work: Promise<T>, context: ExecutionContext): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new DataQueryError("cancelled", "Query execution was cancelled.")));
    const timer = setTimeout(() => finish(() => reject(new DataQueryError("deadline", "The execution deadline was reached."))), Math.max(0, context.deadline - Date.now()));
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
