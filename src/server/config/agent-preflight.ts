import "server-only";
import type { ModelRequest } from "../agent/contracts";
import { AgentRunnerError } from "../agent/runner-contracts";
import { ContextError } from "../context/contracts";

// Translate at composition: the generic runner never inspects context errors.
export function createAgentPreflight(measure: (request: ModelRequest) => unknown) {
  return (request: ModelRequest): void => {
    try {
      measure(request);
    } catch (cause) {
      if (cause instanceof ContextError) {
        const code = cause.code === "context_limit" || cause.code === "configuration" ? cause.code : "protocol";
        throw new AgentRunnerError(code, "The model context could not be continued safely.", {
          cause,
          origin: { boundary: "context", category: cause.code },
        });
      }
      throw cause;
    }
  };
}
