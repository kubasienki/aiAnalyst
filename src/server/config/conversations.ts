import "server-only";
import { createConversationRepository } from "./persistence";
import {
  createConversationService, ConversationServiceError,
  type ConversationService, type PreparedConversationExecution,
} from "../conversations/service";
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

// One SQLite connection per server process, opened on first use. Opening it per
// request would rerun schema initialization on every status poll. A failed open
// is not cached, so the next request retries.
let conversationService: ConversationService | undefined;

export function getConversationService(): ConversationService {
  conversationService ??= createConversationService({
    repository: createConversationRepository(),
    prepareExecution: prepareConversationExecution,
    reportFailure: diagnostic => console.error("Conversation execution failed", diagnostic),
  });
  return conversationService;
}
