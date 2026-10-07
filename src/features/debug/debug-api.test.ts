import { describe, expect, it, vi } from "vitest";
import { createDebugApi } from "./debug-api";
import { totalReportedTokens } from "./presentation";
import type { DebugTrace } from "../../shared/agent-debug";

describe("debugger HTTP decoding", () => {
  it("validates response envelopes and propagates cancellation to fetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ runs: [] }));
    const api = createDebugApi(fetcher);
    const signal = new AbortController().signal;
    expect(await api.list(signal)).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith("/api/debug/agents", { signal, cache: "no-store" });
    fetcher.mockResolvedValueOnce(Response.json({ runs: [{ id: "invalid" }] }));
    await expect(api.list(signal)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json({ run: {}, events: [], evidence: [], traces: [] }));
    await expect(api.load("run", signal)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await expect(api.list(signal)).rejects.toThrow("Could not read local agent data");
  });

  it("distinguishes absent usage from a reported zero and ignores tool payloads", () => {
    const trace: DebugTrace = {
      id: "trace", sequence: 1, kind: "model_call", payloadJson: "{}", startedAt: 1, finishedAt: 2, payload: {},
    };
    expect(totalReportedTokens([trace])).toBeNull();
    const usage = { usage: { inputTokens: 0, outputTokens: 0 } };
    expect(totalReportedTokens([{ ...trace, payload: usage }])).toEqual({ input: 0, output: 0 });
    expect(totalReportedTokens([{ ...trace, kind: "tool_call", payload: usage }])).toBeNull();
  });
});
