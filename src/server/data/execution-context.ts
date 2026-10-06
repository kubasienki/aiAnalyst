import { createExecutionScope, executionStopReason, ExecutionStopped, validExecutionSettings } from "../execution/scope";
import { DataQueryError } from "./errors";
import type { ExecutionContext } from "./types";

type ExecutionOptions = {
  signal?: AbortSignal;
  // Absolute deadline in milliseconds since the Unix epoch.
  deadline?: number;
};

export function createExecutionContext(options: ExecutionOptions = {}): ExecutionContext {
  const signal = options.signal ?? new AbortController().signal;
  const deadline = options.deadline ?? Date.now() + 120_000;
  validateSettings(signal, deadline);
  return {
    signal,
    deadline,
    budget: {
      attemptsUsed: 0,
      maxAttempts: 4,
      resultBytesUsed: 0,
      maxResultBytes: 1024 * 1024,
    },
  };
}

function validateSettings(signal: AbortSignal, deadline: number): void {
  if (!validExecutionSettings(signal, deadline)) {
    throw new DataQueryError("invalid_input", "Query execution settings are invalid.");
  }
}

function stopError(reason: "cancelled" | "deadline"): DataQueryError {
  return new DataQueryError(reason, reason === "cancelled"
    ? "Query execution was cancelled."
    : "The execution deadline was reached.");
}

export function checkExecution(context: ExecutionContext): void {
  validateSettings(context.signal, context.deadline);
  const reason = executionStopReason(context.signal, context.deadline);
  if (reason) {
    throw stopError(reason);
  }
}

// Bounds the caller's wait; it does not cancel the underlying SDK request.
export async function withinDeadline<T>(work: Promise<T>, context: ExecutionContext): Promise<T> {
  const scope = createExecutionScope(context.signal, context.deadline);
  try {
    return await scope.wait(work);
  } catch (error) {
    if (error instanceof ExecutionStopped) {
      throw stopError(error.reason);
    }
    throw error;
  } finally {
    scope.dispose();
  }
}
