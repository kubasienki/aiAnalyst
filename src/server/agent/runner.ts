import "server-only";
import { jsonValueSchema } from "../contracts/json";
import { recoverableToolErrorSchema, type FailureRepeatPolicy, type ModelRequest, type RegisteredTool } from "./contracts";
import { ModelError } from "./errors";
import { createAgentExecution } from "./execution";
import { reportSafely } from "../observability/reporting";
import { createToolTraceRecorder } from "./tracing";
import { errorContent, resolveAction } from "./actions";
import { createToolRegistry, limitsSchema, validateInitialMessages, validateResponse } from "./runner-validation";
import {
  AgentRunnerError, type AgentDiagnostic, type AgentCheckpoint, type AgentResult, type AgentRunnerDependencies,
  type AgentRunInput, type AgentStatistics, type RunnerPhase,
} from "./runner-contracts";

export const DEFAULT_AGENT_LIMITS = Object.freeze({ maxModelRequests: 6, maxOutputTokens: 4_096 });
const ACTION_NOTE = "Application protocol: the previous text is not an accepted final answer. Choose exactly one available tool action. Finish using a terminal tool or request clarification.";

function normalizeFailure(error: unknown): AgentRunnerError {
  if (error instanceof AgentRunnerError) {
    return error;
  }
  if (error instanceof ModelError) {
    switch (error.code) {
      case "cancelled":
      case "deadline":
      case "timeout":
      case "configuration":
      case "context_limit":
        return new AgentRunnerError(error.code, error.message);
      case "invalid_request":
      case "invalid_response":
      case "replay_mismatch":
        return new AgentRunnerError("protocol", "The model interaction could not be continued safely.");
      default:
        return new AgentRunnerError("provider", "The AI provider could not complete the attempt.");
    }
  }
  return new AgentRunnerError("internal", "The agent attempt could not be completed.");
}

function diagnosticOrigin(error: unknown): AgentDiagnostic["origin"] {
  if (error instanceof ModelError) {
    return { boundary: "model", category: error.code };
  }
  if (error instanceof AgentRunnerError) {
    return error.origin;
  }
  return undefined;
}

export function createAgentRunner(dependencies: AgentRunnerDependencies) {
  return async function run<TContext, TOutcome, TArtifact = never>(
    input: AgentRunInput<TContext, TOutcome, TArtifact>,
  ): Promise<AgentResult<TOutcome>> {
    const startedAt = Date.now();
    const statistics: AgentStatistics = { modelRequests: 0, toolExecutions: 0, recoverableErrors: 0, elapsedMs: 0 };
    let phase: RunnerPhase = "configuration";
    let execution: ReturnType<typeof createAgentExecution> | undefined;

    try {
      const limitsResult = limitsSchema.safeParse({ ...DEFAULT_AGENT_LIMITS, ...input.limits });
      if (!limitsResult.success || !(input.signal instanceof AbortSignal) || !Number.isSafeInteger(input.deadline)
        || input.deadline < 0 || typeof input.checkpoint !== "function") {
        throw new AgentRunnerError("configuration", "Agent execution settings are invalid.");
      }
      const limits = limitsResult.data;
      const messages = validateInitialMessages(input.messages);
      const registry = createToolRegistry(input.tools);
      const failedActions = new Map<string, FailureRepeatPolicy>();
      const generatedCallIds = new Set<string>();
      execution = createAgentExecution(input.signal, input.deadline);
      const activeExecution = execution;
      const recordToolTrace = createToolTraceRecorder({
        signal: activeExecution.signal,
        deadline: input.deadline,
        record: input.recordToolCall,
        reportFailure: category => reportSafely(dependencies.reportFailure, {
          category,
          phase: "tool",
          modelRequests: statistics.modelRequests,
          toolExecutions: statistics.toolExecutions,
          elapsedMs: Date.now() - startedAt,
        }),
      });

      function availableTools(): RegisteredTool<TContext, TOutcome, TArtifact>[] {
        const terminalOnly = statistics.modelRequests >= limits.maxModelRequests - 1;
        return [...registry.values()].filter(tool =>
          (!terminalOnly || tool.role === "terminal")
          && (!tool.isAvailable || tool.isAvailable(input.applicationContext)),
        );
      }

      function prepareRequest(requestMessages = messages): ModelRequest {
        const tools = availableTools();
        if (tools.length === 0) {
          throw new AgentRunnerError("budget_exhausted", "No available action can finish this attempt.");
        }
        return {
          messages: [...requestMessages],
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          toolSelection: { kind: "required" },
          maxOutputTokens: limits.maxOutputTokens,
          deadline: input.deadline,
          signal: activeExecution.signal,
          recordTrace: input.recordModelCall,
        };
      }

      async function checkpoint(event: AgentCheckpoint<TOutcome, TArtifact>): Promise<void> {
        activeExecution.check();
        phase = "checkpoint";
        try {
          // Do not race started writes. A terminal checkpoint is the commit point;
          // the caller returns its outcome even if cancellation arrived mid-write.
          await input.checkpoint(event);
        } catch (cause) {
          if (cause instanceof AgentRunnerError && cause.code === "persistence") {
            throw cause;
          }
          throw new AgentRunnerError("persistence", "The execution checkpoint could not be saved.", {
            cause,
            origin: { boundary: "checkpoint", category: "write_failed" },
          });
        }
      }

      async function recordResult(event: Extract<AgentCheckpoint<TOutcome, TArtifact>, { kind: "tool_result" }>) {
        await checkpoint(event);
        activeExecution.check();
        messages.push({ role: "tool", callId: event.callId, content: event.content });
      }

      while (statistics.modelRequests < limits.maxModelRequests) {
        activeExecution.check();
        phase = "preflight";
        const request = prepareRequest();
        dependencies.preflight(request);
        activeExecution.check();
        phase = "model";
        statistics.modelRequests++;
        const response = validateResponse(await activeExecution.wait(dependencies.model.complete(request)));
        activeExecution.check();
        for (const call of response.message.toolCalls) {
          if (generatedCallIds.has(call.callId)) {
            throw new AgentRunnerError("protocol", "The model reused a tool-call ID within this attempt.");
          }
          generatedCallIds.add(call.callId);
        }
        await checkpoint({ kind: "assistant", response });
        activeExecution.check();
        messages.push(response.message);
        phase = "action";

        if (response.message.toolCalls.length === 0) {
          statistics.recoverableErrors++;
          await checkpoint({ kind: "context_note", content: ACTION_NOTE });
          activeExecution.check();
          messages.push({ role: "system", content: ACTION_NOTE });
          continue;
        }
        if (response.message.toolCalls.length > 1) {
          for (const call of response.message.toolCalls) {
            statistics.recoverableErrors++;
            await recordResult({ kind: "tool_result", callId: call.callId, content: errorContent({
              code: "unexpected_batch", message: "No actions in this batch were executed. Choose exactly one available action.",
            }) });
          }
          continue;
        }

        const call = response.message.toolCalls[0];
        if (!call) {
          throw new AgentRunnerError("protocol", "The model did not provide an action.");
        }
        const action = resolveAction(call, registry, new Set(request.tools.map(tool => tool.name)), failedActions, input.applicationContext);
        if (action.kind === "feedback") {
          statistics.recoverableErrors++;
          failedActions.set(action.fingerprint, action.repeatPolicy);
          await recordResult({ kind: "tool_result", callId: call.callId, content: errorContent(action.error) });
          continue;
        }

        activeExecution.check();
        phase = "tool";
        statistics.toolExecutions++;
        const toolStartedAt = Date.now();
        const traceFields = {
          name: call.name,
          argumentsValue: action.argumentsValue,
          startedAt: toolStartedAt,
        };
        let result: Awaited<ReturnType<typeof action.tool.execute>>;
        try {
          result = await activeExecution.wait(action.tool.execute(action.argumentsValue, {
            applicationContext: input.applicationContext,
            canContinue: availableTools().some(tool => tool.role === "continuing"),
            signal: activeExecution.signal,
            deadline: input.deadline,
            checkContinuation(content) {
              activeExecution.check();
              const request = prepareRequest([...messages, { role: "tool", callId: call.callId, content: jsonValueSchema.parse(content) }]);
              dependencies.preflight(request);
              activeExecution.check();
            },
          }));
        } catch (error) {
          await recordToolTrace({
            ...traceFields,
            result: null,
            finishedAt: Date.now(),
            error: error instanceof AgentRunnerError ? error.code : "tool_failed",
          });
          throw error;
        }
        const completedTrace = { ...traceFields, result, finishedAt: Date.now() };
        activeExecution.check();
        if (result.kind === "terminal") {
          if (action.tool.role !== "terminal") {
            throw new AgentRunnerError("internal", "A continuing tool returned a terminal outcome.");
          }
          const acknowledgment = jsonValueSchema.parse(result.acknowledgment);
          await checkpoint({ kind: "terminal", callId: call.callId, acknowledgment, outcome: result.outcome });
          await recordToolTrace(completedTrace);
          statistics.elapsedMs = Date.now() - startedAt;
          return { kind: "terminal", outcome: result.outcome, statistics };
        }
        if (result.kind === "error") {
          const error = recoverableToolErrorSchema.parse(result.error);
          const repeatPolicy = result.repeatPolicy ?? "until_progress";
          if (repeatPolicy !== "unchanged_arguments" && repeatPolicy !== "until_progress") {
            throw new AgentRunnerError("internal", "The tool returned an invalid failure repeat policy.");
          }
          statistics.recoverableErrors++;
          failedActions.set(action.fingerprint, repeatPolicy);
          await recordResult({ kind: "tool_result", callId: call.callId, content: errorContent(error), artifact: result.artifact });
          await recordToolTrace(completedTrace);
          continue;
        }
        if (result.kind !== "continue" || action.tool.role !== "continuing") {
          throw new AgentRunnerError("internal", "The tool returned an invalid execution outcome.");
        }
        await recordResult({ kind: "tool_result", callId: call.callId, content: jsonValueSchema.parse(result.content), artifact: result.artifact });
        await recordToolTrace(completedTrace);
        // Only durable successful work counts as progress. Repairs and failed
        // tools cannot unlock an otherwise identical failed action.
        for (const [fingerprint, repeatPolicy] of failedActions) {
          if (repeatPolicy === "until_progress") {
            failedActions.delete(fingerprint);
          }
        }
      }
      throw new AgentRunnerError("budget_exhausted", "The model-call allowance ended without an accepted terminal action.");
    } catch (error) {
      const origin = diagnosticOrigin(error);
      // Checkpoint rejection retains its persistence category. Otherwise a stop
      // signal wins a concurrent operation failure, with no further execution.
      if (!(error instanceof AgentRunnerError && error.code === "persistence")) {
        try {
          execution?.check();
        } catch (stopError) {
          error = stopError;
        }
      }
      const failure = normalizeFailure(error);
      statistics.elapsedMs = Date.now() - startedAt;
      try {
        dependencies.reportFailure?.({
          category: failure.code,
          phase,
          modelRequests: statistics.modelRequests,
          toolExecutions: statistics.toolExecutions,
          elapsedMs: statistics.elapsedMs,
          ...(origin ? { origin } : {}),
        });
      } catch {
        // Selected diagnostics are best effort and must not mask execution failure.
      }
      return { kind: "failure", error: { code: failure.code, message: failure.message }, statistics };
    } finally {
      execution?.dispose();
    }
  };
}
