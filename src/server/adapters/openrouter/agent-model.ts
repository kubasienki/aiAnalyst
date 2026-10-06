import "server-only";
import type { AgentModel } from "../../agent/contracts";
import { normalizeResponse, serializeRequest } from "./protocol";
import { createOpenRouterTransport, type OpenRouterConfig, type ReportFailure } from "./transport";

export function createOpenRouterAgentModel(
  config: OpenRouterConfig,
  fetcher: typeof fetch = fetch,
  reportFailure?: ReportFailure,
): AgentModel {
  const complete = createOpenRouterTransport(config, fetcher, reportFailure);
  return {
    async complete(request) {
      const body = serializeRequest(request, config.model);
      return complete(
        body,
        { signal: request.signal, deadline: request.deadline },
        envelope => normalizeResponse(envelope, config.model, body.model),
      );
    },
  };
}
