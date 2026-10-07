import "server-only";
import { createConversationRepository } from "./persistence";
import { createConversationService, ConversationServiceError, type PreparedConversationExecution } from "../conversations/service";
import { createContext } from "./context";
import { createAnalyst } from "./analysis";
import { readOpenRouterConfig } from "./openrouter";
import { ANALYSIS_TOOL_DESCRIPTIONS } from "../analysis/contracts";
import { buildAnalystInstructions, ANALYST_PROMPT_VERSION, ANALYSIS_TOOLS_VERSION } from "../analysis/prompt";
import { SEMANTIC_GUIDE_VERSION } from "../data/semantic-guide";

export function prepareConversationExecution(): PreparedConversationExecution {
  const config = readOpenRouterConfig();
  try {
    return {
      versions: {
        model: config.model,
        prompt: ANALYST_PROMPT_VERSION,
        tools: ANALYSIS_TOOLS_VERSION,
        semanticGuide: SEMANTIC_GUIDE_VERSION,
      },
      instructions: buildAnalystInstructions(),
      tools: ANALYSIS_TOOL_DESCRIPTIONS,
      buildContext: createContext(),
      analyze: createAnalyst(),
    };
  } catch (cause) {
    throw new ConversationServiceError("unavailable", "The analytical dependencies are not configured.", { cause });
  }
}

export function openConversationApplication() {
  const repository = createConversationRepository();
  return {
    service: createConversationService({
      repository,
      prepareExecution: prepareConversationExecution,
      reportFailure: diagnostic => console.error("Conversation execution failed", diagnostic),
    }),
    close: () => repository.close(),
  };
}
