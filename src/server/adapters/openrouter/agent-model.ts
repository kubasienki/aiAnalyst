import "server-only";
import type { AgentModel } from "../../agent/contracts";
import { normalizeResponse, serializeRequest } from "./protocol";
import { createOpenRouterTransport, type OpenRouterConfig, type ReportFailure } from "./transport";
import { jsonValueSchema } from "../../contracts/json";

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
        {
          signal: request.signal,
          deadline: request.deadline,
          onTrace: request.recordTrace ? async (trace, response, signal) => {
            await request.recordTrace?.({
              requestBody: jsonValueSchema.parse(body),
              responseBody: trace.responseBody,
              status: trace.status,
              ...(trace.requestId ? { requestId: trace.requestId } : {}),
              ...(trace.errorCategory ? { errorCategory: trace.errorCategory } : {}),
              startedAt: trace.startedAt,
              finishedAt: trace.finishedAt,
              ...(response?.usage ? { usage: response.usage } : {}),
            }, signal);
          } : undefined,
        },
        envelope => normalizeResponse(envelope, config.model, body.model),
      );
    },
  };
}
