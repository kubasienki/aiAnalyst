import { loadEnvConfig } from "@next/env";
import { ModelError } from "../src/server/agent/errors";
import type { ModelMessage, ToolDescription } from "../src/server/agent/contracts";
import { createAgentModel } from "../src/server/config/agent-model";

async function main() {
  loadEnvConfig(process.cwd(), true);
  const model = createAgentModel();
  const signal = new AbortController().signal;
  const deadline = Date.now() + 120_000;
  const tools: ToolDescription[] = [{
    name: "check_connection",
    description: "Return a fixed local connectivity check result.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  }];
  const messages: ModelMessage[] = [
    { role: "system", content: "This is a connectivity check. Call check_connection once, then report whether its result was successful." },
    { role: "user", content: "Check the connection." },
  ];
  const first = await model.complete({
    messages, tools, toolSelection: { kind: "specific", name: "check_connection" },
    maxOutputTokens: 4_096, deadline, signal,
  });
  const call = first.message.toolCalls[0];
  if (first.message.toolCalls.length !== 1 || !call || call.name !== "check_connection") {
    throw new ModelError("invalid_response", "The provider did not return the requested check tool.");
  }
  try {
    const argumentsValue: unknown = JSON.parse(call.argumentsJson);
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)
      || Object.keys(argumentsValue).length !== 0) {
      throw new Error("Invalid check arguments");
    }
  } catch {
    throw new ModelError("invalid_response", "The provider returned invalid check arguments.");
  }
  messages.push(first.message, { role: "tool", callId: call.callId, content: { ok: true } });
  const second = await model.complete({
    messages, tools, toolSelection: { kind: "none" }, maxOutputTokens: 4_096, deadline, signal,
  });
  if (second.finishReason !== "stop" || !second.message.content?.trim()) {
    throw new ModelError("invalid_response", "The provider did not complete the check continuation.");
  }
  // Deliberately omit model content, tool arguments, reasoning, and credentials.
  console.log("OpenRouter tool call and continuation succeeded.", {
    firstRequestId: first.requestId,
    secondRequestId: second.requestId,
    reasoningCaptured: first.message.providerReplay !== undefined,
    firstUsage: first.usage,
    secondUsage: second.usage,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ModelError) {
    console.error(`OpenRouter check failed (${error.code}): ${error.message}`);
  } else {
    console.error("OpenRouter check failed unexpectedly.");
  }
  process.exitCode = 1;
});
