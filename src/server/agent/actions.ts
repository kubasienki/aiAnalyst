import "server-only";
import { createHash } from "node:crypto";
import { jsonValueSchema, type JsonValue } from "../contracts/json";
import { canonicalJson } from "../contracts/json-equality";
import type { FailureRepeatPolicy, RecoverableToolError, RegisteredTool, ToolCall } from "./contracts";

type ResolvedAction<TContext, TOutcome, TArtifact> =
  | { kind: "feedback"; fingerprint: string; error: RecoverableToolError; repeatPolicy: FailureRepeatPolicy }
  | { kind: "dispatch"; fingerprint: string; argumentsValue: JsonValue; tool: RegisteredTool<TContext, TOutcome, TArtifact> };

export function resolveAction<TContext, TOutcome, TArtifact>(
  call: ToolCall,
  registry: Map<string, RegisteredTool<TContext, TOutcome, TArtifact>>,
  offeredTools: Set<string>,
  failedActions: ReadonlyMap<string, FailureRepeatPolicy>,
  context: TContext,
): ResolvedAction<TContext, TOutcome, TArtifact> {
  let argumentsValue: JsonValue | undefined;
  let encodedArguments = `raw:${call.argumentsJson}`;
  try {
    argumentsValue = jsonValueSchema.parse(JSON.parse(call.argumentsJson));
    encodedArguments = `json:${canonicalJson(argumentsValue)}`;
  } catch {
    // Preserve malformed source arguments in the assistant record. Repair
    // feedback never includes raw parser errors or argument contents.
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([call.name, encodedArguments])).digest("hex");
  function feedback(code: string, message: string, repeatPolicy: FailureRepeatPolicy = "unchanged_arguments"): ResolvedAction<TContext, TOutcome, TArtifact> {
    return { kind: "feedback", fingerprint, error: { code, message }, repeatPolicy };
  }
  const previousFailurePolicy = failedActions.get(fingerprint);
  if (previousFailurePolicy) {
    return feedback("duplicate_failed_action", "This identical action already failed. Change the arguments or choose another action.", previousFailurePolicy);
  }
  const tool = registry.get(call.name);
  if (!tool) {
    return feedback("unknown_tool", "Choose a tool from the definitions supplied in this request.");
  }
  if (!offeredTools.has(call.name) || (tool.isAvailable && !tool.isAvailable(context))) {
    return feedback("unavailable_tool", "This tool is unavailable for the current attempt. Choose an available terminal action when investigation limits are exhausted.", "until_progress");
  }
  if (argumentsValue === undefined) {
    return feedback("invalid_json", "Tool arguments must be a valid JSON value matching the advertised schema.");
  }
  return { kind: "dispatch", fingerprint, argumentsValue, tool };
}

export function errorContent(error: RecoverableToolError): JsonValue {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
