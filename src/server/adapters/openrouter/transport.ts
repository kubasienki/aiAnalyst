import "server-only";
import { isRecord } from "../../../shared/chat";
import { ModelError } from "../../agent/errors";
import { safeIdentifier } from "../../contracts/identity";
import { createExecutionScope } from "../../execution/scope";
import { captureTrace } from "../../observability/reporting";

export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// One model call may use at most this long, and never past the run deadline.
const REQUEST_TIMEOUT_MS = 60_000;

export type OpenRouterConfig = { apiKey: string; model: string; maxResponseBytes?: number };
type FailureCategory = "network" | "http" | "invalid_response" | "completion_error" | "truncated" | "filtered" | "timeout" | "deadline" | "response_limit" | "cleanup_failed" | "trace_failed" | "trace_timeout";

export type OpenRouterDiagnostic = {
  category: FailureCategory;
  model: string;
  status?: number;
  requestId?: string;
  providerCode?: number;
  elapsedMs?: number;
};

export type ReportFailure = (diagnostic: OpenRouterDiagnostic) => void;
export type CompletionEnvelope = {
  payload: Record<string, unknown>;
  choice: Record<string, unknown>;
  requestId?: string;
};
export type TransportTrace = {
  responseBody: string | null;
  status: number | null;
  requestId?: string;
  errorCategory?: string;
  startedAt: number;
  finishedAt: number;
};

export function logFailure(diagnostic: OpenRouterDiagnostic) {
  console.error("OpenRouter completion failed", diagnostic);
}

function stopReading(body: ReadableStream<Uint8Array> | null, reportCleanupFailure: () => void): void {
  // Cleanup is best effort; it must not replace the original provider failure.
  if (body) {
    try {
      void body.cancel().catch(reportCleanupFailure);
    } catch {
      reportCleanupFailure();
    }
  }
}

async function readBody(
  response: Response,
  scope: ReturnType<typeof createExecutionScope>,
  byteLimit: number,
  reportCleanupFailure: () => void,
): Promise<string> {
  if (!response.body) {
    throw new ModelError("invalid_response", "The AI provider returned an empty response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await scope.wait(reader.read());
      if (chunk.done) {
        fragments.push(decoder.decode());
        return fragments.join("");
      }
      bytes += chunk.value.byteLength;
      if (bytes > byteLimit) {
        throw new ModelError("response_limit", "The AI provider response exceeded the configured size limit.");
      }
      fragments.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    try {
      void reader.cancel().catch(reportCleanupFailure);
    } catch {
      reportCleanupFailure();
    }
    if (error instanceof TypeError) {
      throw new ModelError("invalid_response", "The AI provider returned an unreadable response.");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ModelError("invalid_response", "The AI provider returned invalid JSON.");
  }
}

function isContextOverflow(error: Record<string, unknown> | undefined): boolean {
  if (!error) {
    return false;
  }
  if (error.code === "context_length_exceeded" || error.code === "context_window_exceeded") {
    return true;
  }
  // Inspect only a known failure description; never expose or log its contents.
  return typeof error.message === "string"
    && /maximum context length|context (?:window|length) (?:exceeded|limit)/i.test(error.message);
}

function readProviderError(payload: unknown, choice: unknown): Record<string, unknown> | undefined {
  if (isRecord(payload) && isRecord(payload.error)) {
    return payload.error;
  }
  if (isRecord(choice) && isRecord(choice.error)) {
    return choice.error;
  }
  return undefined;
}

export function createOpenRouterTransport(
  config: OpenRouterConfig,
  fetcher: typeof fetch = fetch,
  reportFailure: ReportFailure = logFailure,
) {
  const byteLimit = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!config.apiKey.trim() || !config.model.trim() || !Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
    throw new ModelError("configuration", "OpenRouter configuration is invalid.");
  }

  return async function complete<T>(
    body: Record<string, unknown>,
    options: { signal: AbortSignal; deadline?: number; onTrace?: (trace: TransportTrace, result: T | undefined, signal: AbortSignal) => Promise<void> },
    normalize: (envelope: CompletionEnvelope) => T,
  ): Promise<T> {
    const startedAt = Date.now();
    const requestDeadline = Math.min(startedAt + REQUEST_TIMEOUT_MS, options.deadline ?? Infinity);
    // Checked against the wall clock, not only timers, because a busy event loop
    // delays timers and synchronous parsing can run past the deadline.
    function stopReason(): ModelError | undefined {
      if (options.signal.aborted) {
        return new ModelError("cancelled", "The request was cancelled.");
      }
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        return new ModelError("deadline", "The execution deadline was reached.");
      }
      if (Date.now() >= requestDeadline) {
        return new ModelError("timeout", "The AI response took too long. Please retry.");
      }
      return undefined;
    }
    function checkExecutionBudget(): void {
      const stop = stopReason();
      if (stop) {
        throw stop;
      }
    }
    checkExecutionBudget();
    const scope = createExecutionScope(options.signal, requestDeadline);
    const diagnostic: OpenRouterDiagnostic = { category: "network", model: config.model };
    let rawResponseBody: string | null = null;
    let completedResult: T | undefined;
    let completed = false;
    function reportDiagnostic(category: FailureCategory): void {
      try {
        reportFailure({ ...diagnostic, category, elapsedMs: Date.now() - startedAt });
      } catch {
        // Diagnostics are best effort and contain no request/response contents.
      }
    }
    function reportCleanupFailure(): void {
      reportDiagnostic("cleanup_failed");
    }

    try {
      const responsePromise = fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: scope.signal,
      }).then(response => {
        // Native fetch obeys abort. Injected/custom transports may resolve after a
        // stop; dispose their body, since the caller has stopped waiting for it.
        if (stopReason()) {
          stopReading(response.body, reportCleanupFailure);
        }
        return response;
      });
      const response = await scope.wait(responsePromise);
      diagnostic.status = response.status;
      diagnostic.requestId = safeIdentifier(response.headers.get("x-request-id"));

      if (!response.ok && response.status !== 400) {
        diagnostic.category = "http";
        const responseLengthHeader = response.headers.get("content-length");
        const responseLength = responseLengthHeader === null ? Number.NaN : Number(responseLengthHeader);
        if (Number.isSafeInteger(responseLength) && responseLength >= 0 && responseLength <= byteLimit) {
          rawResponseBody = await readBody(response, scope, byteLimit, reportCleanupFailure);
        } else {
          // Unknown-length error streams are disposed instead of risking a stalled model call.
          stopReading(response.body, reportCleanupFailure);
        }
        throw new ModelError("provider", "The AI provider could not complete the request. Please retry.");
      }

      diagnostic.category = "invalid_response";
      const responseBody = await readBody(response, scope, byteLimit, reportCleanupFailure);
      rawResponseBody = responseBody;
      checkExecutionBudget();
      let payload: unknown;
      if (!response.ok) {
        diagnostic.category = "http";
        try {
          payload = JSON.parse(responseBody);
        } catch {
          throw new ModelError("provider", "The AI provider could not complete the request. Please retry.");
        }
      } else {
        payload = parseJson(responseBody);
      }
      const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      const providerError = readProviderError(payload, choice);
      if (!response.ok || providerError || (isRecord(choice) && choice.finish_reason === "error")) {
        diagnostic.category = response.ok ? "completion_error" : "http";
        if (typeof providerError?.code === "number" && Number.isSafeInteger(providerError.code)) {
          diagnostic.providerCode = providerError.code;
        }
        if (isContextOverflow(providerError)) {
          throw new ModelError("context_limit", "The AI request exceeded the model's context capacity.");
        }
        const message = response.ok
          ? "The AI provider could not complete the reply. Please retry."
          : "The AI provider could not complete the request. Please retry.";
        throw new ModelError("provider", message);
      }
      if (!isRecord(payload) || !isRecord(choice)) {
        throw new ModelError("invalid_response", "The AI provider returned an invalid reply. Please retry.");
      }
      if (choice.finish_reason === "length") {
        diagnostic.category = "truncated";
        throw new ModelError("truncated", "The AI reply reached its length limit. Try asking for a shorter answer.");
      }
      if (choice.finish_reason === "content_filter") {
        diagnostic.category = "filtered";
        throw new ModelError("filtered", "The AI provider could not return this reply. Try rephrasing your question.");
      }
      const result = normalize({ payload, choice, requestId: diagnostic.requestId });
      checkExecutionBudget();
      completedResult = result;
      completed = true;
      return result;
    } catch (error) {
      // A stop wins over whatever failure it caused, such as an aborted read.
      const stop = stopReason();
      if (stop?.code === "cancelled") {
        throw stop;
      }
      if (stop) {
        error = stop;
      }
      if (error instanceof ModelError
        && (error.code === "response_limit" || error.code === "deadline" || error.code === "timeout")) {
        diagnostic.category = error.code;
      }
      reportDiagnostic(diagnostic.category);
      if (error instanceof ModelError) {
        throw error;
      }
      throw new ModelError("provider", "The AI provider could not be reached. Please retry.");
    } finally {
      scope.dispose();
      if (options.onTrace) {
        const onTrace = options.onTrace;
        const finishedAt = Date.now();
        await captureTrace({
          signal: options.signal,
          deadline: requestDeadline,
          reportFailure: reportDiagnostic,
          write: signal => onTrace({
            responseBody: rawResponseBody,
            status: diagnostic.status ?? null,
            requestId: diagnostic.requestId,
            errorCategory: completed ? undefined : diagnostic.category,
            startedAt,
            finishedAt,
          }, completedResult, signal),
        });
      }
    }
  };
}
