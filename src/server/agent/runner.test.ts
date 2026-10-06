import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ContextError } from "../context/contracts";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { measureContextRequest } from "../context/budget";
import { ModelError } from "./errors";
import type { AgentModel, ModelRequest, ModelResponse, RegisteredTool, ToolExecution, ToolInvocationContext } from "./contracts";
import type { AgentCheckpoint, AgentRunInput } from "./runner-contracts";
import { createAgentRunner } from "./runner";
import { registerTool } from "./tool-registration";

type State = { attempts: number };
type Outcome = { kind: "answer"; text: string } | { kind: "clarification"; question: string };
type Artifact = { evidenceId: string };
type Tool = RegisteredTool<State, Outcome, Artifact>;
type Checkpoint = AgentCheckpoint<Outcome, Artifact>;
type Input = AgentRunInput<State, Outcome, Artifact>;

function action(name = "finish", argumentsJson = '{"text":"Answer"}', callId: string = randomUUID()): ModelResponse {
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, toolCalls: [{ callId, name, argumentsJson }] } };
}

function text(): ModelResponse {
  return { finishReason: "stop", message: { role: "assistant", content: "Unaccepted prose", toolCalls: [] } };
}

function tools(queryHandler?: (context: ToolInvocationContext<State>) => Promise<ToolExecution<Outcome, Artifact>>): Tool[] {
  return [
    registerTool<{ sql: string }, State, Outcome, Artifact>({
      name: "query", description: "Query data", role: "continuing",
      argumentsSchema: z.strictObject({ sql: z.string().min(1) }),
      isAvailable: state => state.attempts < 4,
      async handle(_argumentsValue, context) {
        if (queryHandler) {
          return queryHandler(context);
        }
        context.applicationContext.attempts++;
        return { kind: "continue", content: { rows: [{ revenue: "12.5" }] }, artifact: { evidenceId: "evidence-1" } };
      },
    }),
    registerTool<{ text: string }, State, Outcome, Artifact>({
      name: "finish", description: "Finish answer", role: "terminal",
      argumentsSchema: z.strictObject({ text: z.string().min(1) }),
      async handle(argumentsValue) {
        return { kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "answer", text: argumentsValue.text } };
      },
    }),
    registerTool<{ question: string }, State, Outcome, Artifact>({
      name: "clarify", description: "Ask clarification", role: "terminal",
      argumentsSchema: z.strictObject({ question: z.string().min(1) }),
      async handle(argumentsValue) {
        return { kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "clarification", question: argumentsValue.question } };
      },
    }),
  ];
}

function setup(responses: ModelResponse[] = [action()]) {
  let index = 0;
  const complete = vi.fn<AgentModel["complete"]>().mockImplementation(async () => {
    const response = responses[index++];
    if (!response) {
      throw new Error("Unexpected model request");
    }
    return response;
  });
  const preflight = vi.fn<(request: ModelRequest) => void>();
  const reportFailure = vi.fn();
  const checkpoints: Checkpoint[] = [];
  const checkpoint = vi.fn<Input["checkpoint"]>().mockImplementation(async event => { checkpoints.push(event); });
  const input: Input = {
    messages: [{ role: "system", content: "Analyst" }, { role: "user", content: "Revenue?" }],
    tools: tools(), applicationContext: { attempts: 0 }, signal: new AbortController().signal,
    deadline: Date.now() + 120_000, checkpoint,
  };
  const run = createAgentRunner({ model: { complete }, preflight, reportFailure });
  return { run, input, complete, preflight, reportFailure, checkpoints, checkpoint };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded agent runner", () => {
  it("completes only after the terminal checkpoint and preserves caller messages", async () => {
    const f = setup();
    const before = structuredClone(f.input.messages);
    const result = await f.run(f.input);
    expect(result).toMatchObject({ kind: "terminal", outcome: { kind: "answer", text: "Answer" }, statistics: { modelRequests: 1, toolExecutions: 1 } });
    expect(f.checkpoints.map(event => event.kind)).toEqual(["assistant", "terminal"]);
    expect(f.input.messages).toEqual(before);
    expect(f.preflight).toHaveBeenCalledOnce();
  });

  it("returns clarification as a terminal outcome without waiting for a user", async () => {
    const f = setup([action("clarify", '{"question":"Which month?"}')]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", outcome: { kind: "clarification", question: "Which month?" } });
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("dispatches sequential investigation and carries results, artifacts, and reasoning forward", async () => {
    const first = action("query", '{ "sql": "SELECT 1" }');
    first.message.content = "Investigating";
    first.message.providerReplay = { origin: { model: "test/model" }, reasoning: "unchanged", reasoningDetails: [{ signature: "signed", data: "opaque" }] };
    const f = setup([first, action("query", '{"sql":"SELECT 2"}'), action()]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", statistics: { modelRequests: 3, toolExecutions: 3 } });
    const continuation = f.complete.mock.calls[1]?.[0];
    expect(continuation?.messages).toContainEqual(first.message);
    expect(continuation?.messages.at(-1)).toMatchObject({ role: "tool", content: { rows: [{ revenue: "12.5" }] } });
    expect(f.checkpoints[1]).toMatchObject({ kind: "tool_result", artifact: { evidenceId: "evidence-1" } });
    expect(f.checkpoints.map(event => event.kind)).toEqual(["assistant", "tool_result", "assistant", "tool_result", "assistant", "terminal"]);
  });

  it.each([
    ["query", "{broken", "invalid_json"],
    ["query", "{}", "invalid_arguments"],
    ["missing", "{}", "unknown_tool"],
  ])("repairs %s arguments %s through matching feedback", async (name, args, code) => {
    const first = action(name, args);
    const f = setup([first, action()]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", statistics: { recoverableErrors: 1 } });
    expect(f.checkpoints[1]).toMatchObject({ kind: "tool_result", callId: first.message.toolCalls[0]?.callId, content: { ok: false, error: { code } } });
    expect(f.input.applicationContext.attempts).toBe(0);
  });

  it("suppresses identical failures despite changed JSON object key order", async () => {
    const handler = vi.fn(async (): Promise<ToolExecution<Outcome, Artifact>> => ({ kind: "error", error: { code: "rejected_sql", message: "Choose supported SQL" } }));
    const f = setup([action("query", '{"sql":"bad","extra":1}'), action("query", '{"extra":1,"sql":"bad"}'), action()]);
    // Use an open argument schema here so the handler rather than argument
    // validation returns the first failure.
    const query = registerTool<{ sql: string; extra: number }, State, Outcome, Artifact>({
      name: "query", description: "Query", role: "continuing", argumentsSchema: z.strictObject({ sql: z.string(), extra: z.number() }), handle: handler,
    });
    f.input.tools = [query, ...tools().filter(tool => tool.role === "terminal")];
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(handler).toHaveBeenCalledOnce();
    expect(f.checkpoints[3]).toMatchObject({ content: { error: { code: "duplicate_failed_action" } } });
  });

  it("does not suppress successful repeated actions", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action("query", '{"sql":"SELECT 1"}'), action()]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(f.input.applicationContext.attempts).toBe(2);
  });

  it("reconsiders an identical terminal action after obtaining missing evidence", async () => {
    const finish = vi.fn(async (_argumentsValue: { text: string }, context: ToolInvocationContext<State>): Promise<ToolExecution<Outcome, Artifact>> => {
      if (context.applicationContext.attempts === 0) {
        return { kind: "error", error: { code: "missing_evidence", message: "Obtain evidence first." } };
      }
      return { kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "answer", text: "Supported answer" } };
    });
    const f = setup([action(), action("query", '{"sql":"SELECT 1"}'), action()]);
    f.input.limits = { maxModelRequests: 3 };
    f.input.tools = [
      ...tools().filter(tool => tool.name !== "finish"),
      registerTool<{ text: string }, State, Outcome, Artifact>({
        name: "finish", description: "Finish with evidence", role: "terminal",
        argumentsSchema: z.strictObject({ text: z.string() }), handle: finish,
      }),
    ];
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", outcome: { text: "Supported answer" } });
    expect(finish).toHaveBeenCalledTimes(2);
    expect(f.checkpoints.map(event => event.kind)).toEqual([
      "assistant", "tool_result", "assistant", "tool_result", "assistant", "terminal",
    ]);
  });

  it("does not unlock state-dependent failures through corrective feedback", async () => {
    const handler = vi.fn(async (): Promise<ToolExecution<Outcome, Artifact>> => ({
      kind: "error", error: { code: "temporarily_unavailable", message: "Investigate first." },
    }));
    const f = setup([
      action("query", '{"sql":"SELECT 1"}'), action("unknown"),
      action("query", '{"sql":"SELECT 1"}'), action(),
    ]);
    f.input.tools = tools(handler);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(handler).toHaveBeenCalledOnce();
    expect(f.checkpoints[5]).toMatchObject({ content: { error: { code: "duplicate_failed_action" } } });
  });

  it("keeps deterministic argument and SQL failures blocked after successful progress", async () => {
    const handler = vi.fn(async (argumentsValue: { sql: string }): Promise<ToolExecution<Outcome, Artifact>> => {
      if (argumentsValue.sql === "bad") {
        return {
          kind: "error", error: { code: "rejected_sql", message: "Choose supported SQL." },
          repeatPolicy: "unchanged_arguments",
        };
      }
      return { kind: "continue", content: { rows: [1] } };
    });
    const f = setup([
      action("query", '{}'), action("query", '{"sql":"bad"}'),
      action("query", '{"sql":"SELECT 1"}'), action("query", '{}'),
      action("query", '{"sql":"bad"}'), action(),
    ]);
    f.input.tools = [
      registerTool<{ sql: string }, State, Outcome, Artifact>({
        name: "query", description: "Query", role: "continuing",
        argumentsSchema: z.strictObject({ sql: z.string() }), handle: handler,
      }),
      ...tools().filter(tool => tool.role === "terminal"),
    ];
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(f.checkpoints[7]).toMatchObject({ content: { error: { code: "duplicate_failed_action" } } });
    expect(f.checkpoints[9]).toMatchObject({ content: { error: { code: "duplicate_failed_action" } } });
  });

  it("rejects all calls in an unexpected mixed batch without executing any handler", async () => {
    const response = action("query", '{"sql":"SELECT 1"}');
    response.message.toolCalls.push(...action().message.toolCalls);
    const f = setup([response, action()]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", statistics: { toolExecutions: 1, recoverableErrors: 2 } });
    expect(f.checkpoints.filter(event => event.kind === "tool_result")).toHaveLength(2);
    expect(f.input.applicationContext.attempts).toBe(0);
    const next = f.complete.mock.calls[1]?.[0].messages;
    expect(next?.filter(message => message.role === "tool")).toHaveLength(2);
  });

  it("checkpoints text-only repair notes instead of accepting prose or inventing user messages", async () => {
    const f = setup([text(), action()]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(f.checkpoints.map(event => event.kind)).toEqual(["assistant", "context_note", "assistant", "terminal"]);
    const next = f.complete.mock.calls[1]?.[0].messages;
    expect(next?.at(-1)).toMatchObject({ role: "system" });
    expect(next?.filter(message => message.role === "user")).toHaveLength(1);
  });

  it("rejects call-ID reuse before another checkpoint or execution", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}', "same"), action("finish", '{"text":"Answer"}', "same")]);
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "protocol" } });
    expect(f.checkpoints).toHaveLength(2);
    expect(f.input.applicationContext.attempts).toBe(1);
  });

  it("exhausts exactly six model requests and reserves the last for terminal actions", async () => {
    const f = setup(Array.from({ length: 6 }, () => text()));
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "budget_exhausted" }, statistics: { modelRequests: 6 } });
    expect(f.complete.mock.calls[5]?.[0].tools.map(tool => tool.name)).toEqual(["finish", "clarify"]);
  });

  it("hides tools whose live application allowance is exhausted without double-counting it", async () => {
    const f = setup([
      ...Array.from({ length: 4 }, (_, index) => action("query", JSON.stringify({ sql: `SELECT ${index}` }))),
      action("query", '{"sql":"SELECT 5"}'), action(),
    ]);
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal", statistics: { modelRequests: 6, toolExecutions: 5 } });
    expect(f.input.applicationContext.attempts).toBe(4);
    expect(f.complete.mock.calls[4]?.[0].tools.map(tool => tool.name)).not.toContain("query");
    expect(f.checkpoints[9]).toMatchObject({ content: { error: { code: "unavailable_tool" } } });
  });

  it("rechecks availability after assistant checkpoint before dispatch", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action()]);
    f.checkpoint.mockImplementation(async event => {
      f.checkpoints.push(event);
      if (event.kind === "assistant") { f.input.applicationContext.attempts = 4; }
    });
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(f.checkpoints[1]).toMatchObject({ content: { error: { code: "unavailable_tool" } } });
  });

  it("preflights each request and stops when complete continuation context does not fit", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action()]);
    f.preflight.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new ContextError("context_limit", "Input limit"); });
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "context_limit" }, statistics: { modelRequests: 1 } });
    expect(f.checkpoints).toHaveLength(2);
  });

  it("offers handlers the same paired-result preflight and forwards fallback artifacts", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action()]);
    f.input.tools = tools(async context => {
      context.checkContinuation({ rows: [1, 2] });
      return { kind: "error", error: { code: "result_too_large_for_context", message: "Request a smaller result" }, artifact: { evidenceId: "stored-full-result" } };
    });
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
    expect(f.preflight).toHaveBeenCalledTimes(3);
    expect(f.preflight.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({ role: "tool", content: { rows: [1, 2] } });
    expect(f.checkpoints[1]).toMatchObject({ artifact: { evidenceId: "stored-full-result" } });
  });

  it("works with the real serializer-based context preflight without external requests", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action()]);
    const measurer = createOpenRouterRequestMeasurer("test/model");
    f.preflight.mockImplementation(request => { measureContextRequest(request, measurer, { contextWindowTokens: 65_536, safetyTokens: 2_048 }); });
    expect(await f.run(f.input)).toMatchObject({ kind: "terminal" });
  });

  it.each(["assistant", "tool_result", "terminal", "context_note"])("stops on rejected %s checkpoints", async kind => {
    const f = setup([kind === "context_note" ? text() : action("query", '{"sql":"SELECT 1"}'), action()]);
    f.checkpoint.mockImplementation(async event => {
      if (event.kind === kind) { throw new Error("secret database details"); }
    });
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "persistence", message: "The execution checkpoint could not be saved." } });
    expect(JSON.stringify(f.reportFailure.mock.calls)).not.toContain("secret");
    if (kind === "assistant") { expect(f.input.applicationContext.attempts).toBe(0); }
  });

  it("waits for assistant checkpoint before dispatch and stops after mid-write cancellation", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}')]);
    const write = Promise.withResolvers<void>();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.checkpoint.mockImplementation(() => write.promise);
    let settled = false;
    const pending = f.run(f.input).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.input.applicationContext.attempts).toBe(0);
    write.resolve();
    expect(await pending).toMatchObject({ kind: "failure", error: { code: "cancelled" } });
  });

  it("keeps a successful terminal commit when cancellation arrives during its write", async () => {
    const f = setup();
    const write = Promise.withResolvers<void>();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.checkpoint.mockImplementation(event => event.kind === "terminal" ? write.promise : Promise.resolve());
    const pending = f.run(f.input);
    await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalledTimes(2));
    controller.abort();
    write.resolve();
    expect(await pending).toMatchObject({ kind: "terminal" });
  });

  it.each(["model", "tool"] as const)("cancels uncooperative %s work and ignores late results", async phase => {
    const late = Promise.withResolvers<ModelResponse>();
    const lateTool = Promise.withResolvers<ToolExecution<Outcome, Artifact>>();
    const f = setup([action("query", '{"sql":"SELECT 1"}')]);
    const controller = new AbortController();
    f.input.signal = controller.signal;
    const handler = vi.fn(() => lateTool.promise);
    if (phase === "model") { f.complete.mockImplementation(() => late.promise); }
    else { f.input.tools = tools(handler); }
    const pending = f.run(f.input);
    await vi.waitFor(() => expect(phase === "model" ? f.complete : handler).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ kind: "failure", error: { code: "cancelled" } });
    const checkpointCount = f.checkpoint.mock.calls.length;
    late.resolve(action());
    lateTool.resolve({ kind: "continue", content: { ok: true } });
    await Promise.resolve();
    expect(f.checkpoint).toHaveBeenCalledTimes(checkpointCount);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("handles deadline expiry, aborts the derived signal, and clears its timer", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.input.deadline = Date.now() + 100;
    f.complete.mockImplementation(() => new Promise(() => {}));
    const pending = f.run(f.input);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ kind: "failure", error: { code: "deadline" } });
    expect(f.complete.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a successful terminal commit when the deadline expires during its write", async () => {
    vi.useFakeTimers();
    const f = setup();
    const write = Promise.withResolvers<void>();
    f.input.deadline = Date.now() + 100;
    f.checkpoint.mockImplementation(event => event.kind === "terminal" ? write.promise : Promise.resolve());
    const pending = f.run(f.input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.checkpoint).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    write.resolve();
    expect(await pending).toMatchObject({ kind: "terminal" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes late model rejection after cancellation", async () => {
    const f = setup();
    const late = Promise.withResolvers<ModelResponse>();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.complete.mockImplementation(() => late.promise);
    const pending = f.run(f.input);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: "cancelled" } });
    late.reject(new Error("Late provider failure"));
    await Promise.resolve();
    expect(f.checkpoint).not.toHaveBeenCalled();
  });

  it("rejects terminal outcomes returned by continuing tools", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}')]);
    f.input.tools = tools(async () => ({
      kind: "terminal", acknowledgment: { accepted: true }, outcome: { kind: "answer", text: "Invalid finish" },
    }));
    expect(await f.run(f.input)).toMatchObject({ error: { code: "internal" } });
    expect(f.checkpoints.map(event => event.kind)).toEqual(["assistant"]);
  });

  it("rejects a late success before delayed deadline timers execute", async () => {
    vi.useFakeTimers();
    const f = setup();
    const start = Date.now();
    f.input.deadline = start + 100;
    f.complete.mockImplementation(async () => { vi.setSystemTime(start + 101); return action(); });
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "deadline" } });
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no work for an already cancelled or expired attempt", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await f.run({ ...f.input, signal: controller.signal })).toMatchObject({ kind: "failure", error: { code: "cancelled" } });
    expect(await f.run({ ...f.input, deadline: Date.now() - 1 })).toMatchObject({ kind: "failure", error: { code: "deadline" } });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.checkpoint).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected handler errors and never treats them as repairable", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}')]);
    f.input.tools = tools(async () => { throw new Error("secret SQL and credentials"); });
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: "internal", message: "The agent attempt could not be completed." } });
    expect(JSON.stringify(f.reportFailure.mock.calls)).not.toContain("secret");
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider", "provider"], ["truncated", "provider"], ["invalid_response", "protocol"],
    ["timeout", "timeout"], ["context_limit", "context_limit"],
  ] as const)("maps %s model failures to %s without retry", async (code, expected) => {
    const f = setup();
    f.complete.mockRejectedValue(new ModelError(code, "Safe failure"));
    expect(await f.run(f.input)).toMatchObject({ kind: "failure", error: { code: expected }, statistics: { modelRequests: 1 } });
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("rejects invalid limits, registry definitions, and unfinished initial history", async () => {
    const f = setup();
    expect(await f.run({ ...f.input, limits: { maxModelRequests: 0 } })).toMatchObject({ error: { code: "configuration" } });
    expect(await f.run({ ...f.input, tools: [...tools(), ...tools()] })).toMatchObject({ error: { code: "configuration" } });
    expect(await f.run({ ...f.input, tools: tools().filter(tool => tool.role === "continuing") })).toMatchObject({ error: { code: "configuration" } });
    expect(await f.run({ ...f.input, messages: [action("query").message] })).toMatchObject({ error: { code: "configuration" } });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("isolates concurrent invocations and tolerates a failing diagnostic sink", async () => {
    const f = setup([action("query", '{"sql":"SELECT 1"}'), action(), action(), action()]);
    f.reportFailure.mockImplementation(() => { throw new Error("sink failure"); });
    const second: Input = { ...f.input, applicationContext: { attempts: 0 }, checkpoint: vi.fn(async () => {}) };
    const [firstResult, secondResult] = await Promise.all([f.run(f.input), f.run(second)]);
    expect(firstResult.kind).toBe("terminal");
    expect(secondResult.kind).toBe("terminal");
    expect(firstResult.statistics).not.toBe(secondResult.statistics);
    expect(await f.run({ ...f.input, limits: { maxModelRequests: 0 } })).toMatchObject({ error: { code: "configuration" } });
  });
});
