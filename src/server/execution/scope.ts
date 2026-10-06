export type ExecutionStopReason = "cancelled" | "deadline";

export class ExecutionStopped extends Error {
  constructor(public readonly reason: ExecutionStopReason) {
    super(`Execution stopped: ${reason}`);
    this.name = "ExecutionStopped";
  }
}

export function validExecutionSettings(signal: unknown, deadline: unknown): boolean {
  return signal instanceof AbortSignal
    && typeof deadline === "number"
    && Number.isSafeInteger(deadline)
    && deadline >= 0;
}

export function executionStopReason(signal: AbortSignal, deadline: number): ExecutionStopReason | undefined {
  if (signal.aborted) {
    return "cancelled";
  }
  if (Date.now() >= deadline) {
    return "deadline";
  }
  return undefined;
}

// The owner disposes this scope when its operation ends. Waiting consumes late
// rejections but cannot guarantee cancellation of the underlying operation.
export function createExecutionScope(signal: AbortSignal, deadline: number) {
  if (!validExecutionSettings(signal, deadline)) {
    throw new TypeError("Invalid execution settings.");
  }
  const deadlineController = new AbortController();
  const combinedSignal = AbortSignal.any([signal, deadlineController.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleDeadline(): void {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      deadlineController.abort();
      return;
    }
    // Node timer delays are signed 32-bit integers. Recheck long deadlines in chunks.
    timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  }
  scheduleDeadline();

  function check(): void {
    const reason = executionStopReason(signal, deadline)
      ?? (deadlineController.signal.aborted ? "deadline" : undefined);
    if (reason) {
      throw new ExecutionStopped(reason);
    }
  }

  function wait<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      function onAbort(): void {
        combinedSignal.removeEventListener("abort", onAbort);
        try {
          check();
        } catch (error) {
          reject(error);
        }
      }
      combinedSignal.addEventListener("abort", onAbort, { once: true });
      // Attach both handlers even when cancellation wins, consuming late rejections.
      work.then(value => {
        combinedSignal.removeEventListener("abort", onAbort);
        try {
          check();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      }, error => {
        combinedSignal.removeEventListener("abort", onAbort);
        try {
          check();
          reject(error);
        } catch (stopError) {
          reject(stopError);
        }
      });
      if (combinedSignal.aborted) {
        onAbort();
      }
    });
  }

  return { signal: combinedSignal, deadline, check, wait, dispose: () => clearTimeout(timer) };
}
