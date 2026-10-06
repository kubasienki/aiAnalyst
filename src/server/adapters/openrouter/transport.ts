import "server-only";
import { isRecord } from "../../../shared/chat";
import { ModelError } from "../../agent/errors";

export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type OpenRouterConfig = { apiKey: string; model: string; maxResponseBytes?: number };
type FailureCategory = "network" | "http" | "invalid_response" | "completion_error" | "truncated" | "filtered" | "timeout" | "deadline" | "response_limit";

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

export function logFailure(diagnostic: OpenRouterDiagnostic) {
  console.error("OpenRouter completion failed", diagnostic);
}

export function safeIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,200}$/.test(value)) {
    return value;
  }
  return undefined;
}

function stopReading(body: ReadableStream<Uint8Array> | null): void {
  // Cleanup is best effort; it must not replace the original provider failure.
  if (body) {
    void body.cancel().catch(() => undefined);
  }
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    function onAbort() {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    // Attach both handlers even if cancellation wins, consuming late rejections.
    work.then(value => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function readBody(response: Response, signal: AbortSignal, byteLimit: number): Promise<string> {
  if (!response.body) {
    throw new ModelError("invalid_response", "The AI provider returned an empty response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await withAbort(reader.read(), signal);
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
    void reader.cancel().catch(() => undefined);
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
    options: { signal: AbortSignal; deadline?: number },
    normalize: (envelope: CompletionEnvelope) => T,
  ): Promise<T> {
    if (options.signal.aborted) {
      throw new ModelError("cancelled", "The request was cancelled.");
    }
    const startedAt = Date.now();
    const remainingMs = options.deadline === undefined ? 60_000 : options.deadline - startedAt;
    if (remainingMs <= 0) {
      throw new ModelError("deadline", "The execution deadline was reached.");
    }
    const timeout = AbortSignal.timeout(Math.min(60_000, remainingMs));
    const requestSignal = AbortSignal.any([options.signal, timeout]);
    const diagnostic: OpenRouterDiagnostic = { category: "network", model: config.model };
    // Timers can be delayed by a busy event loop. Check wall-clock budgets too,
    // including after synchronous response parsing/validation.
    const requestDeadline = Math.min(startedAt + 60_000, options.deadline ?? Infinity);
    function checkExecutionBudget(): void {
      if (options.signal.aborted) {
        throw new ModelError("cancelled", "The request was cancelled.");
      }
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        throw new ModelError("deadline", "The execution deadline was reached.");
      }
      if (timeout.aborted || Date.now() >= requestDeadline) {
        throw new ModelError("timeout", "The AI response took too long. Please retry.");
      }
    }

    try {
      const responsePromise = fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      }).then(response => {
        // Native fetch obeys abort. Injected/custom transports may resolve later;
        // dispose their body even after the caller has stopped waiting.
        if (requestSignal.aborted) {
          stopReading(response.body);
        }
        return response;
      });
      const response = await withAbort(responsePromise, requestSignal);
      diagnostic.status = response.status;
      diagnostic.requestId = safeIdentifier(response.headers.get("x-request-id"));
      try {
        checkExecutionBudget();
      } catch (error) {
        stopReading(response.body);
        throw error;
      }

      if (!response.ok && response.status !== 400) {
        diagnostic.category = "http";
        stopReading(response.body);
        throw new ModelError("provider", "The AI provider could not complete the request. Please retry.");
      }
      diagnostic.category = "invalid_response";
      const responseBody = await readBody(response, requestSignal, byteLimit);
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
      return result;
    } catch (error) {
      if (options.signal.aborted) {
        throw new ModelError("cancelled", "The request was cancelled.");
      }
      if (timeout.aborted) {
        const deadlineReached = options.deadline !== undefined && Date.now() >= options.deadline;
        diagnostic.category = deadlineReached ? "deadline" : "timeout";
        error = new ModelError(diagnostic.category, deadlineReached
          ? "The execution deadline was reached."
          : "The AI response took too long. Please retry.");
      }
      if (error instanceof ModelError && error.code === "response_limit") {
        diagnostic.category = "response_limit";
      }
      if (error instanceof ModelError && (error.code === "deadline" || error.code === "timeout")) {
        diagnostic.category = error.code;
      }
      diagnostic.elapsedMs = Date.now() - startedAt;
      // A diagnostic sink must never mask the original failure.
      try {
        reportFailure(diagnostic);
      } catch {
        // Diagnostics are best effort and contain no request/response contents.
      }
      if (error instanceof ModelError) {
        throw error;
      }
      throw new ModelError("provider", "The AI provider could not be reached. Please retry.");
    }
  };
}
