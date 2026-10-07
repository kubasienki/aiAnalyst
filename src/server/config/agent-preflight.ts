import "server-only";
import type { ModelRequest } from "../agent/contracts";
import { AgentRunnerError } from "../agent/runner-contracts";
import { ContextError, contextFailureCode } from "../context/contracts";

// Translate at composition: the generic runner never inspects context errors.
export function createAgentPreflight(measure: (request: ModelRequest) => unknown) {
  return (request: ModelRequest): void => {
    try {
      measure(request);
    } catch (cause) {
      if (cause instanceof ContextError) {
        throw new AgentRunnerError(contextFailureCode(cause), "The model context could not be continued safely.", {
          cause,
          origin: { boundary: "context", category: cause.code },
        });
      }
      throw cause;
    }
  };
}
