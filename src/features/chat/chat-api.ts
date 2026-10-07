import {
  apiErrorResponseSchema, chatStreamEventSchema, conversationSnapshotSchema, submissionResponseSchema,
  type ApiError, type ChatStreamEvent, type ConversationSnapshot,
} from "../../shared/conversations";
import type { PendingOperation } from "./storage";

export class ChatRequestError extends Error {
  constructor(public readonly status: number, public readonly detail: ApiError) {
    super(detail.message);
    this.name = "ChatRequestError";
  }
}

export interface ChatApi {
  create(signal: AbortSignal): Promise<ConversationSnapshot>;
  load(id: string, signal: AbortSignal): Promise<ConversationSnapshot>;
  submit(operation: PendingOperation, signal: AbortSignal, onEvent: (event: ChatStreamEvent) => void): Promise<void>;
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const payload: unknown = await response.json();
  const parsed = apiErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("The server returned an invalid response. Check status before resending.");
  }
  throw new ChatRequestError(response.status, parsed.data.error);
}

// Framing is independent of fetch and UI state so fragmentation can be tested.
export function createSseDecoder(onEvent: (event: ChatStreamEvent) => void) {
  let buffer = "";
  let eventName = "";
  let data: string[] = [];

  function line(value: string): void {
    if (value === "") {
      if (data.length > 0) {
        const payload: unknown = JSON.parse(data.join("\n"));
        const event = chatStreamEventSchema.parse(payload);
        if (eventName && eventName !== event.kind) {
          throw new Error("Stream event identity does not match its payload.");
        }
        onEvent(event);
      }
      eventName = "";
      data = [];
      return;
    }
    if (value.startsWith(":")) {
      return;
    }
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let content = separator < 0 ? "" : value.slice(separator + 1);
    if (content.startsWith(" ")) {
      content = content.slice(1);
    }
    if (field === "event") {
      eventName = content;
    } else if (field === "data") {
      data.push(content);
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        throw new Error("Stream frame is too large.");
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let value = buffer.slice(0, newline);
        if (value.endsWith("\r")) {
          value = value.slice(0, -1);
        }
        line(value);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
  };
}

export function createChatApi(fetcher: typeof fetch = fetch): ChatApi {
  async function snapshotRequest(url: string, signal: AbortSignal, method = "GET"): Promise<ConversationSnapshot> {
    const response = await fetcher(url, { method, signal, cache: "no-store" });
    await checkResponse(response);
    const payload: unknown = await response.json();
    return conversationSnapshotSchema.parse(payload);
  }

  return {
    create: signal => snapshotRequest("/api/conversations", signal, "POST"),
    load: (id, signal) => snapshotRequest(`/api/conversations/${id}`, signal),
    async submit(operation, signal, onEvent) {
      let url = `/api/conversations/${operation.conversationId}/messages`;
      const body: Record<string, string> = {
        clientMessageId: operation.clientMessageId,
        expectedRevision: operation.expectedRevision,
      };
      if (operation.kind === "message") {
        body.message = operation.message;
      } else {
        url = `/api/conversations/${operation.conversationId}/runs/${operation.runId}/retry`;
      }
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
        cache: "no-store",
      });
      await checkResponse(response);
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
        const payload: unknown = await response.json();
        const duplicate = submissionResponseSchema.parse(payload);
        onEvent({ kind: "accepted", ...duplicate });
        return;
      }
      if (!response.body) {
        throw new Error("The analysis response was interrupted. Check status.");
      }
      let terminal = false;
      const parser = createSseDecoder(event => {
        if (terminal) {
          throw new Error("The stream continued after its terminal event.");
        }
        if (event.kind === "answer" || event.kind === "clarification" || event.kind === "error") {
          terminal = true;
        }
        onEvent(event);
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            parser.push(decoder.decode());
            break;
          }
          parser.push(decoder.decode(chunk.value, { stream: true }));
        }
        if (!terminal) {
          throw new Error("The analysis response was interrupted. Check status.");
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
