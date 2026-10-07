import { describe, expect, it } from "vitest";
import { ContextError } from "../context/contracts";
import type { ModelRequest } from "../agent/contracts";
import { AgentRunnerError } from "../agent/runner-contracts";
import { createAgentPreflight } from "./agent-preflight";

const request: ModelRequest = {
  messages: [], tools: [], toolSelection: { kind: "none" }, maxOutputTokens: 100,
  signal: new AbortController().signal, deadline: Date.now() + 1000,
};

describe("agent preflight boundary", () => {
  it.each(["context_limit", "configuration", "replay_mismatch"] as const)("translates %s with safe provenance", category => {
    const preflight = createAgentPreflight(() => { throw new ContextError(category, "private input"); });
    try {
      preflight(request);
      throw new Error("Expected preflight to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRunnerError);
      expect(error).toMatchObject({
        code: category === "replay_mismatch" ? "protocol" : category,
        origin: { boundary: "context", category },
      });
      expect(String(error)).not.toContain("private input");
    }
  });
});
