import "server-only";
import { createOpenRouterAgentModel } from "../adapters/openrouter/agent-model";
import { readOpenRouterConfig } from "./openrouter";

export function createAgentModel() {
  return createOpenRouterAgentModel(readOpenRouterConfig());
}
