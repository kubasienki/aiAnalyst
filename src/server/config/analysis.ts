import "server-only";
import { createAgentRunner } from "../agent/runner";
import { createOpenRouterRequestMeasurer } from "../adapters/openrouter/request-measurer";
import { createAnalysisService } from "../analysis/service";
import { measureContextRequest } from "../context/budget";
import { createAgentModel } from "./agent-model";
import { readContextBudget } from "./context";
import { createDataLayer } from "./data-layer";
import { readOpenRouterConfig } from "./openrouter";

// No database opens at import or construction. The conversation caller supplies
// built context and an awaited persistence callback for each invocation.
export function createAnalyst() {
  const config = readOpenRouterConfig();
  const measurer = createOpenRouterRequestMeasurer(config.model);
  const budget = readContextBudget();
  return createAnalysisService({
    executeQuery: createDataLayer(),
    runAgent: createAgentRunner({
      model: createAgentModel(),
      preflight(request) {
        measureContextRequest(request, measurer, budget);
      },
    }),
  });
}
