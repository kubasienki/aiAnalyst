import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, ModelRequest } from "../../agent/contracts";
import { createOpenRouterAgentModel } from "./agent-model";
import { readOpenRouterConfig } from "../../config/openrouter";
import { createOpenRouterTransport } from "./transport";

const config = { apiKey: "secret-key", model: "test/model" };
const tools = [{ name: "run_sql", description: "Query the data", parameters: { type: "object", properties: {} } }];
const call = { callId: "call-1", name: "run_sql", argumentsJson: '{ "sql": "SELECT 1" }' };

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [{ role: "user", content: "How much revenue?" }],
    tools,
    toolSelection: { kind: "required" },
    maxOutputTokens: 4_096,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function payload(message: unknown = { role: "assistant", content: "Answer" }, finishReason = "stop") {
  return { id: "generation-1", model: "test/model", choices: [{ finish_reason: finishReason, message }] };
}

function setup(value: unknown = payload(), options: { status?: number; maxResponseBytes?: number } = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status: options.status ?? 200 }));
  const diagnostics = vi.fn();
  const model = createOpenRouterAgentModel({ ...config, maxResponseBytes: options.maxResponseBytes }, fetcher, diagnostics);
  return { model, fetcher, diagnostics };
}

function sentBody(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tool-capable OpenRouter adapter", () => {
  it("preserves a valid response and a provider failure when trace storage rejects", async () => {
    const recordTrace = vi.fn(async () => { throw new Error("private trace failure"); });
    const success = setup();
    expect(await success.model.complete(request({ recordTrace }))).toMatchObject({ finishReason: "stop" });
    expect(success.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "trace_failed" }));
    const failure = setup({ error: { code: "provider_error" } }, { status: 400 });
    await expect(failure.model.complete(request({ recordTrace }))).rejects.toMatchObject({ code: "provider" });
    expect(JSON.stringify(failure.diagnostics.mock.calls)).not.toContain("private");
  });

  it("bounds a stalled model trace without changing the validated response", async () => {
    vi.useFakeTimers();
    const f = setup();
    const pending = f.model.complete(request({ recordTrace: () => new Promise<void>(() => {}) }));
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ finishReason: "stop" });
    expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "trace_timeout" }));
  });

  it("sends native tool definitions and required parameter routing", async () => {
    const { model, fetcher } = setup();
    const result = await model.complete(request());
    expect(sentBody(fetcher)).toEqual({
      model: config.model, messages: [{ role: "user", content: "How much revenue?" }],
      tools: [{ type: "function", function: tools[0] }], tool_choice: "required",
      provider: { require_parameters: true }, stream: false, max_tokens: 4_096,
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
    // A normally completed text reply remains valid even if a tool was requested.
    expect(result).toMatchObject({ finishReason: "stop", message: { content: "Answer", toolCalls: [] }, requestId: "generation-1" });
  });

  it("records the exact outbound body, raw provider reply, timing, and usage", async () => {
    const value = payload({ role: "assistant", content: "Answer" });
    Object.assign(value, { usage: { prompt_tokens: 23, completion_tokens: 7 } });
    const { model, fetcher } = setup(value);
    const recordTrace = vi.fn(async () => {});

    await model.complete(request({ recordTrace }));

    expect(recordTrace).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: sentBody(fetcher),
      responseBody: JSON.stringify(value),
      status: 200,
      usage: { inputTokens: 23, outputTokens: 7 },
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
    }), expect.any(AbortSignal));
  });

  it.each([
    [{ kind: "none" }, "none"],
    [{ kind: "specific", name: "run_sql" }, { type: "function", function: { name: "run_sql" } }],
  ] as const)("maps tool selection %j", async (toolSelection, expected) => {
    const { model, fetcher } = setup();
    await model.complete(request({ toolSelection }));
    expect(sentBody(fetcher).tool_choice).toEqual(expected);
  });

  it("retains mixed content, all calls, unknown names and malformed argument JSON for the runner", async () => {
    const { model } = setup(payload({
      role: "assistant", content: "Investigating",
      tool_calls: [
        { id: "a", type: "function", function: { name: "run_sql", arguments: '{ "sql": "SELECT 1" }' } },
        { id: "b", type: "function", function: { name: "unknown", arguments: "{broken" } },
      ],
    }, "tool_calls"));
    const result = await model.complete(request());
    expect(result.message.toolCalls).toEqual([
      { callId: "a", name: "run_sql", argumentsJson: '{ "sql": "SELECT 1" }' },
      { callId: "b", name: "unknown", argumentsJson: "{broken" },
    ]);
    expect(result.message.content).toBe("Investigating");
  });

  it("serializes matching results once and sends tools again on continuation", async () => {
    const { model, fetcher } = setup();
    await model.complete(request({ messages: [
      { role: "user", content: "Question" },
      { role: "assistant", content: null, toolCalls: [call] },
      { role: "tool", callId: call.callId, content: { rows: [["12.5", null]], ok: true } },
    ] }));
    expect(sentBody(fetcher).messages.slice(1)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: call.callId, type: "function", function: { name: call.name, arguments: call.argumentsJson } }] },
      { role: "tool", tool_call_id: call.callId, content: '{"rows":[["12.5",null]],"ok":true}' },
    ]);
    expect(sentBody(fetcher).tools).toHaveLength(1);
  });

  const brokenSequences: ModelMessage[][] = [
    [{ role: "tool", callId: "orphan", content: {} }],
    [{ role: "assistant", content: null, toolCalls: [call] }],
    [{ role: "assistant", content: null, toolCalls: [call] }, { role: "user", content: "Interrupt" }],
    [{ role: "assistant", content: null, toolCalls: [call] }, { role: "tool", callId: "wrong", content: {} }],
    [{ role: "assistant", content: null, toolCalls: [call] }, { role: "tool", callId: call.callId, content: {} }, { role: "tool", callId: call.callId, content: {} }],
  ];
  it.each(brokenSequences.map(messages => ({ messages })))("rejects broken call/result sequences before HTTP: %j", async ({ messages }) => {
    const { model, fetcher } = setup();
    await expect(model.complete(request({ messages }))).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows a call ID to recur in a later resolved batch", async () => {
    const { model } = setup();
    await expect(model.complete(request({ messages: [
      { role: "assistant", content: null, toolCalls: [call] },
      { role: "tool", callId: call.callId, content: {} },
      { role: "assistant", content: null, toolCalls: [call] },
      { role: "tool", callId: call.callId, content: {} },
    ] }))).resolves.toMatchObject({ finishReason: "stop" });
  });

  it("requires every call in a batch to be resolved and allows results in either order", async () => {
    const { model } = setup();
    const assistant: ModelMessage = {
      role: "assistant", content: null, toolCalls: [call, { ...call, callId: "call-2" }],
    };
    await expect(model.complete(request({ messages: [assistant,
      { role: "tool", callId: call.callId, content: {} },
    ] }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(model.complete(request({ messages: [assistant,
      { role: "tool", callId: "call-2", content: {} },
      { role: "tool", callId: call.callId, content: {} },
    ] }))).resolves.toMatchObject({ finishReason: "stop" });
  });

  it.each([
    { tools: [] }, { tools: [tools[0], tools[0]] },
    { toolSelection: { kind: "specific", name: "missing" } },
    { maxOutputTokens: 0 }, { deadline: NaN },
    { tools: [{ ...tools[0], parameters: { type: "string" } }] },
  ] satisfies Partial<ModelRequest>[])("rejects invalid requests before HTTP: %j", async overrides => {
    const { model, fetcher } = setup();
    await expect(model.complete(request(overrides))).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [payload({ content: "Missing role" }), "invalid_response"],
    [payload({ role: "user", content: "Wrong role" }), "invalid_response"],
    [payload({ role: "assistant", content: null }), "invalid_response"],
    [payload({ role: "assistant", content: " ", tool_calls: [] }), "invalid_response"],
    [payload({ role: "assistant", content: null, tool_calls: [] }, "tool_calls"), "invalid_response"],
    [payload({ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "run_sql", arguments: {} } }] }, "tool_calls"), "invalid_response"],
    [payload({ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "run_sql", arguments: "{}" } }] }), "invalid_response"],
    [payload({ role: "assistant", content: "Partial" }, "length"), "truncated"],
    [payload(undefined, "content_filter"), "filtered"],
    [{ error: { code: 503, message: "secret-provider-body" } }, "provider"],
    [payload(undefined, "error"), "provider"],
    [{}, "invalid_response"],
  ])("rejects unusable response %j", async (value, code) => {
    const { model } = setup(value);
    await expect(model.complete(request())).rejects.toMatchObject({ code });
  });

  it("captures opaque reasoning unchanged and prefers structured replay on continuation", async () => {
    const blocks = [{ type: "reasoning.encrypted", data: "opaque", signature: "signed", index: 0 }];
    const value = { ...payload({ role: "assistant", content: "Answer", reasoning: "private", reasoning_details: blocks }), model: "resolved/model", provider: "TestProvider" };
    const { model, fetcher } = setup(value);
    const first = await model.complete(request());
    expect(first.message.providerReplay).toEqual({
      origin: { model: "resolved/model", requestedModel: config.model, provider: "TestProvider" },
      reasoning: "private", reasoningDetails: blocks,
    });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    await model.complete(request({ messages: [first.message, { role: "user", content: "Continue" }] }));
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.model).toBe("resolved/model");
    expect(body.messages[0].reasoning_details).toEqual(blocks);
    expect(body.messages[0]).not.toHaveProperty("reasoning");
    expect(body.provider).toEqual({ require_parameters: true, only: ["TestProvider"], allow_fallbacks: false });
  });

  it("replays plaintext reasoning when structured blocks are absent", async () => {
    const { model, fetcher } = setup();
    await model.complete(request({ messages: [{ role: "assistant", content: "Answer", toolCalls: [], providerReplay: {
      origin: { model: config.model }, reasoning: "private", reasoningDetails: [],
    } }] }));
    expect(sentBody(fetcher).messages[0].reasoning).toBe("private");
  });

  it("pins a router continuation to the resolved model and preserves its requested origin", async () => {
    const routerModel = "openrouter/auto";
    const firstPayload = {
      ...payload({ role: "assistant", content: null, reasoning: "private", tool_calls: [{
        id: call.callId, type: "function", function: { name: call.name, arguments: call.argumentsJson },
      }] }, "tool_calls"),
      model: "resolved/model-A",
    };
    // If the next response omits model metadata, fallback identity must be the
    // pinned request model, while requestedModel keeps the configured alias.
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPayload)))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Answer", reasoning: "continued" } }],
      })));
    const model = createOpenRouterAgentModel({ ...config, model: routerModel }, fetcher, vi.fn());
    const first = await model.complete(request());
    const second = await model.complete(request({ messages: [
      first.message, { role: "tool", callId: call.callId, content: { ok: true } },
    ] }));
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.model).toBe("resolved/model-A");
    expect(second.message.providerReplay?.origin).toMatchObject({
      model: "resolved/model-A", requestedModel: routerModel,
    });
  });

  it("rejects conflicting resolved models even when their requested alias is identical", async () => {
    const routerModel = "openrouter/auto";
    const fetcher = vi.fn<typeof fetch>();
    const model = createOpenRouterAgentModel({ ...config, model: routerModel }, fetcher, vi.fn());
    const messages: ModelMessage[] = ["resolved/A", "resolved/B"].map(resolvedModel => ({
      role: "assistant", content: "Answer", toolCalls: [],
      providerReplay: {
        origin: { model: resolvedModel, requestedModel: routerModel, provider: "SameProvider" }, reasoning: "private",
      },
    }));
    await expect(model.complete(request({ messages }))).rejects.toMatchObject({ code: "replay_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats null reasoning as absent and validates structured blocks", async () => {
    const { model } = setup(payload({ role: "assistant", content: "Answer", reasoning: null, reasoning_details: null }));
    expect((await model.complete(request())).message.providerReplay).toBeUndefined();
    const invalid = setup(payload({ role: "assistant", content: "Answer", reasoning_details: ["bad"] }));
    await expect(invalid.model.complete(request())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects cross-model and conflicting-provider replay before HTTP", async () => {
    const { model, fetcher } = setup();
    const assistant = (modelName: string, provider: string): ModelMessage => ({
      role: "assistant", content: "Answer", toolCalls: [],
      providerReplay: { origin: { model: modelName, provider }, reasoning: "private" },
    });
    await expect(model.complete(request({ messages: [assistant("different/model", "A")] }))).rejects.toMatchObject({ code: "replay_mismatch" });
    await expect(model.complete(request({ messages: [assistant(config.model, "A"), assistant(config.model, "B")] }))).rejects.toMatchObject({ code: "replay_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes usage, cache and reasoning tokens without inventing usage", async () => {
    const { model } = setup({ ...payload(), usage: { prompt_tokens: 20, completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } } });
    expect((await model.complete(request())).usage).toEqual({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 12, reasoningTokens: 5 });
    expect((await setup({ ...payload(), usage: { prompt_tokens: -1 } }).model.complete(request())).usage).toBeUndefined();
  });

  it("classifies context overflow without leaking provider descriptions", async () => {
    const { model, diagnostics } = setup({ error: { code: "context_length_exceeded", message: "secret-provider-body" } }, { status: 400 });
    await expect(model.complete(request())).rejects.toMatchObject({ code: "context_limit" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret");
  });

  it("enforces the response byte limit and rejects partial reasoning", async () => {
    const { model } = setup(payload({ role: "assistant", content: "Answer", reasoning: "x".repeat(1_000) }), { maxResponseBytes: 500 });
    await expect(model.complete(request())).rejects.toMatchObject({ code: "response_limit" });
    const complete = setup(payload({ role: "assistant", content: "Answer", reasoning: "x".repeat(20_000) }));
    expect((await complete.model.complete(request())).message.providerReplay?.reasoning).toHaveLength(20_000);
  });

  it("rejects malformed JSON, invalid UTF-8, and duplicate response call IDs", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{invalid"))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff])))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload({
        role: "assistant", content: null, tool_calls: [1, 2].map(() => ({
          id: "same", type: "function", function: { name: "run_sql", arguments: "{}" },
        })),
      }, "tool_calls"))));
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(model.complete(request())).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("prefers a safe header request ID and excludes unsafe identifiers from diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload()), { headers: { "x-request-id": "header-1" } }))
      .mockResolvedValueOnce(new Response("secret-body", { status: 429, headers: { "x-request-id": "Bearer secret-token" } }));
    const diagnostics = vi.fn();
    const model = createOpenRouterAgentModel(config, fetcher, diagnostics);
    expect((await model.complete(request())).requestId).toBe("header-1");
    await expect(model.complete(request())).rejects.toMatchObject({ code: "provider" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret");
  });

  it("does not call HTTP for cancelled or expired requests", async () => {
    const { model, fetcher } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(model.complete(request({ signal: controller.signal }))).rejects.toMatchObject({ code: "cancelled" });
    await expect(model.complete(request({ deadline: Date.now() - 1 }))).rejects.toMatchObject({ code: "deadline" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels waiting for a response body and performs best-effort reader cleanup", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    const controller = new AbortController();
    const pending = model.complete(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("honors a shared deadline even if HTTP ignores abort, without retrying", async () => {
    vi.useFakeTimers();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      setTimeout(() => timeout.abort(), milliseconds);
      return timeout.signal;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    const result = expect(model.complete(request({ deadline: Date.now() + 100 }))).rejects.toMatchObject({ code: "deadline" });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(fetcher).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("rejects a late response and disposes its body before the abort timer fires", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      // Advance the clock without running timers, simulating event-loop delay.
      vi.setSystemTime(startedAt + 101);
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    });
    const diagnostics = vi.fn();
    const model = createOpenRouterAgentModel(config, fetcher, diagnostics);
    await expect(model.complete(request({ deadline: startedAt + 100 }))).rejects.toMatchObject({ code: "deadline" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "deadline" }));
  });

  it("rechecks the deadline after response-body reading without relying on timers", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        vi.setSystemTime(startedAt + 101);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload())));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    await expect(model.complete(request({ deadline: startedAt + 100 }))).rejects.toMatchObject({ code: "deadline" });
  });

  it("rechecks the deadline after synchronous response normalization", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const complete = createOpenRouterTransport(config, fetcher, vi.fn());
    await expect(complete({}, { signal: new AbortController().signal, deadline: startedAt + 100 }, () => {
      vi.setSystemTime(startedAt + 101);
      return "Answer";
    })).rejects.toMatchObject({ code: "deadline" });
  });

  it("enforces the 60-second request ceiling when the run deadline is later", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      vi.setSystemTime(startedAt + 60_001);
      return new Response(JSON.stringify(payload()));
    });
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    await expect(model.complete(request({ deadline: startedAt + 120_000 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("disposes a response that arrives after caller cancellation", async () => {
    let deliverResponse: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => {
      deliverResponse = resolve;
    }));
    const model = createOpenRouterAgentModel(config, fetcher, vi.fn());
    const controller = new AbortController();
    const pending = model.complete(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    deliverResponse?.(response);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("rejects oversized chunked bodies even without Content-Length", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(80)));
        controller.enqueue(new TextEncoder().encode("b".repeat(80)));
      },
      cancel: cancelled,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const model = createOpenRouterAgentModel({ ...config, maxResponseBytes: 100 }, fetcher, vi.fn());
    await expect(model.complete(request())).rejects.toMatchObject({ code: "response_limit" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reports failed reader cleanup without masking cancellation when the sink throws: %s", async throwingSink => {
    const body = new ReadableStream<Uint8Array>({
      cancel() { return Promise.reject(new Error("secret stream contents")); },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const diagnostics = vi.fn(() => {
      if (throwingSink) {
        throw new Error("diagnostic sink failed");
      }
    });
    const model = createOpenRouterAgentModel(config, fetcher, diagnostics);
    const controller = new AbortController();
    const pending = model.complete(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "cleanup_failed" })));
    expect(body.locked).toBe(false);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret stream");
  });

  it("reports failed response disposal while preserving the provider failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() { return Promise.reject(new Error("secret cleanup failure")); },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 }));
    const diagnostics = vi.fn();
    const model = createOpenRouterAgentModel(config, fetcher, diagnostics);
    await expect(model.complete(request())).rejects.toMatchObject({ code: "provider" });
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "cleanup_failed" })));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ category: "http", status: 503 }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret cleanup");
  });

  it("sanitizes network failures and ignores diagnostic sink failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-key secret-prompt"));
    const diagnostics = vi.fn(() => { throw new Error("sink failed"); });
    const model = createOpenRouterAgentModel(config, fetcher, diagnostics);
    await expect(model.complete(request())).rejects.toMatchObject({ code: "provider", message: "The AI provider could not be reached. Please retry." });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret");
  });
});

describe("OpenRouter configuration", () => {
  it("loads credentials lazily and defaults to a 2 MiB response budget", () => {
    expect(readOpenRouterConfig({ OPENROUTER_API_KEY: " key ", OPENROUTER_MODEL: " model " })).toEqual({ apiKey: "key", model: "model", maxResponseBytes: 2 * 1024 * 1024 });
    expect(() => readOpenRouterConfig({})).toThrow("Chat is not configured");
  });

  it.each(["0", "-1", "1.5", "NaN", "1e6", "9007199254740992"])("rejects invalid response budget %s", value => {
    expect(() => readOpenRouterConfig({ OPENROUTER_API_KEY: "key", OPENROUTER_MODEL: "model", OPENROUTER_MAX_RESPONSE_BYTES: value })).toThrow("positive integer");
  });
});
