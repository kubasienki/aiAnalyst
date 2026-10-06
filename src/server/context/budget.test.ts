import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../agent/contracts";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { serializeRequest } from "../adapters/openrouter/protocol";
import { readContextBudget } from "../config/context";
import { measureContextRequest } from "./budget";
import type { ContextBudget, ModelRequestMeasurer } from "./contracts";

function request(): ModelRequest {
  return {
    messages: [
      { role: "system", content: "Instructions with Unicode: żółć 🎉" },
      { role: "user", content: 'Quote "quoted", newline\n and slash \\' },
      { role: "assistant", content: "Earlier response", toolCalls: [], providerReplay: {
        origin: { model: "test/model" }, reasoning: "private reasoning",
      } },
    ],
    tools: [{ name: "query", description: "Query definition", parameters: { type: "object", properties: {} } }],
    toolSelection: { kind: "required" }, maxOutputTokens: 4_096,
    deadline: Date.now() + 120_000, signal: new AbortController().signal,
  };
}

const fixedMeasurer: ModelRequestMeasurer = {
  measure: () => ({ requestBytes: 900, estimatedInputTokens: 1_000, estimator: "test-tokenizer" }),
};

describe("context request measurement", () => {
  it("measures the same full encoded request as OpenRouter, including tools and reasoning", () => {
    const input = request();
    const encoded = JSON.stringify(serializeRequest(input, "test/model"));
    const measurement = createOpenRouterRequestMeasurer("test/model").measure(input);
    expect(measurement).toEqual({ requestBytes: Buffer.byteLength(encoded, "utf8"), estimatedInputTokens: Buffer.byteLength(encoded, "utf8"), estimator: "serialized-utf8-bytes-v1" });
    expect(measurement.requestBytes).toBeGreaterThan(encoded.length);
    const smaller = createOpenRouterRequestMeasurer("test/model").measure({ ...input, tools: [], toolSelection: { kind: "none" }, messages: [{ role: "user", content: "Question" }] });
    expect(smaller.requestBytes).toBeLessThan(measurement.requestBytes);
  });

  it("accepts the exact boundary and separately reports bytes, tokens, and reservations", () => {
    expect(measureContextRequest(request(), fixedMeasurer, { contextWindowTokens: 7_144, safetyTokens: 2_048 })).toEqual({
      requestBytes: 900, estimatedInputTokens: 1_000, estimator: "test-tokenizer", contextWindowTokens: 7_144,
      outputReservationTokens: 4_096, safetyReservationTokens: 2_048, remainingInputTokens: 0,
    });
    expect(() => measureContextRequest(request(), fixedMeasurer, { contextWindowTokens: 7_143, safetyTokens: 2_048 })).toThrowError(expect.objectContaining({ code: "context_limit" }));
  });

  it.each([
    { contextWindowTokens: 0, safetyTokens: 0 }, { contextWindowTokens: 6_144, safetyTokens: 2_048 },
    { contextWindowTokens: 10_000, safetyTokens: -1 }, { contextWindowTokens: NaN, safetyTokens: 0 },
  ] satisfies ContextBudget[])("rejects invalid allowances or reservations: %j", budget => {
    expect(() => measureContextRequest(request(), fixedMeasurer, budget)).toThrowError(expect.objectContaining({ code: "configuration" }));
  });

  it("rejects invalid measurer output", () => {
    expect(() => measureContextRequest(request(), { measure: () => ({ requestBytes: -1, estimatedInputTokens: 1, estimator: "invalid" }) }, { contextWindowTokens: 65_536, safetyTokens: 2_048 })).toThrowError(expect.objectContaining({ code: "configuration" }));
  });

  it("loads configuration lazily with the agreed defaults", () => {
    expect(readContextBudget({})).toEqual({ contextWindowTokens: 65_536, safetyTokens: 2_048 });
    expect(readContextBudget({ AGENT_CONTEXT_WINDOW_TOKENS: "131072" })).toEqual({ contextWindowTokens: 131_072, safetyTokens: 2_048 });
  });

  it.each(["0", "6144", "-1", "1.5", "1e6", "NaN", "9007199254740992"])("rejects invalid environment allowance %s", value => {
    expect(() => readContextBudget({ AGENT_CONTEXT_WINDOW_TOKENS: value })).toThrowError(expect.objectContaining({ code: "configuration" }));
  });
});
