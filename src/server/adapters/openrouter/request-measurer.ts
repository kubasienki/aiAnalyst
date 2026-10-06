import "server-only";
import type { ModelRequestMeasurer } from "../../context/contracts";
import { serializeRequest } from "./protocol";

export function createOpenRouterRequestMeasurer(model: string): ModelRequestMeasurer {
  return {
    measure(request) {
      const body = serializeRequest(request, model);
      const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
      // Deliberately conservative fallback, not an exact tokenizer or guaranteed
      // token bound. Keep its identity visible for calibration/replacement later.
      return { requestBytes, estimatedInputTokens: requestBytes, estimator: "serialized-utf8-bytes-v1" };
    },
  };
}
