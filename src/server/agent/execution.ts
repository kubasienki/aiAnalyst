import "server-only";
import { createExecutionScope, ExecutionStopped } from "../execution/scope";
import { AgentRunnerError } from "./runner-contracts";

function mapStop(error: unknown): never {
  if (error instanceof ExecutionStopped) {
    throw new AgentRunnerError(error.reason, error.reason === "cancelled"
      ? "The request was cancelled."
      : "The execution deadline was reached.");
  }
  throw error;
}

export function createAgentExecution(signal: AbortSignal, deadline: number) {
  const scope = createExecutionScope(signal, deadline);
  return {
    signal: scope.signal,
    deadline,
    check(): void {
      try {
        scope.check();
      } catch (error) {
        mapStop(error);
      }
    },
    async wait<T>(work: Promise<T>): Promise<T> {
      try {
        return await scope.wait(work);
      } catch (error) {
        mapStop(error);
      }
    },
    dispose: scope.dispose,
  };
}

export type AgentExecution = ReturnType<typeof createAgentExecution>;
