import "server-only";
import { AgentRunnerError } from "./runner-contracts";

export function createAgentExecution(signal: AbortSignal, deadline: number) {
  const deadlineController = new AbortController();
  const combinedSignal = AbortSignal.any([signal, deadlineController.signal]);
  // Long deadlines stay valid; schedule successive bounded timers rather than
  // overflowing Node's signed 32-bit timer delay.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleDeadline() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      deadlineController.abort();
      return;
    }
    timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  }
  scheduleDeadline();

  function check(): void {
    if (signal.aborted) {
      throw new AgentRunnerError("cancelled", "The request was cancelled.");
    }
    if (Date.now() >= deadline || deadlineController.signal.aborted) {
      throw new AgentRunnerError("deadline", "The execution deadline was reached.");
    }
  }

  function wait<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      function onAbort() {
        combinedSignal.removeEventListener("abort", onAbort);
        try {
          check();
        } catch (error) {
          reject(error);
        }
      }
      combinedSignal.addEventListener("abort", onAbort, { once: true });
      // Always attach both handlers: cancellation stops waiting, not necessarily
      // the underlying operation. Late rejections must remain consumed.
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
        reject(error);
      });
      if (combinedSignal.aborted) {
        onAbort();
      }
    });
  }

  return { signal: combinedSignal, deadline, check, wait, dispose: () => clearTimeout(timer) };
}

export type AgentExecution = ReturnType<typeof createAgentExecution>;
