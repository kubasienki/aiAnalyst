import { describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent, ConversationSnapshot } from "../../shared/conversations";
import { createChatApi, createSseDecoder } from "./chat-api";
import type { PendingOperation } from "./storage";

function snapshot(): ConversationSnapshot {
  return { conversationId: "e17ae363-a63c-4fa3-8df5-b8da9b7e5756", revision: "v1:0:0", turns: [] };
}

describe("chat HTTP and event stream boundary", () => {
  it("decodes UTF-8, CRLF and split data lines before validating each event", () => {
    const received: ChatStreamEvent[] = [];
    const decoder = createSseDecoder(event => received.push(event));
    const frame = `: heartbeat\r\nevent: accepted\r\ndata: {"kind":"accepted",\r\ndata: "runId":"1459be9a-0ad9-4c75-a4ba-9fb34e728a5a","snapshot":{"conversationId":"e17ae363-a63c-4fa3-8df5-b8da9b7e5756","revision":"v1:0:0","turns":[]}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(frame);
    const first = new TextDecoder().decode(bytes.slice(0, 17));
    const second = new TextDecoder().decode(bytes.slice(17));
    decoder.push(first);
    expect(received).toHaveLength(0);
    decoder.push(second);
    expect(received).toMatchObject([{ kind: "accepted", snapshot: { revision: "v1:0:0" } }]);
  });

  it("rejects mismatched event names and malformed payloads", () => {
    const decoder = createSseDecoder(() => {});
    expect(() => decoder.push("event: answer\ndata: {\"kind\":\"progress\",\"runId\":\"1459be9a-0ad9-4c75-a4ba-9fb34e728a5a\",\"phase\":\"thinking\"}\n\n"))
      .toThrow("Stream event identity does not match its payload.");
    expect(() => createSseDecoder(() => {}).push("event: answer\ndata: not json\n\n")).toThrow();
  });

  it("posts stable identities and reconciles a running duplicate through JSON", async () => {
    const value = snapshot();
    const runId = "1459be9a-0ad9-4c75-a4ba-9fb34e728a5a";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ runId, snapshot: value }, { status: 202 }));
    const api = createChatApi(fetcher);
    const operation: PendingOperation = {
      kind: "message", conversationId: value.conversationId,
      clientMessageId: "0b14b98a-42dd-41d8-9c9b-27ddb2e48404", expectedRevision: value.revision, message: "Revenue?",
    };
    const event = vi.fn();
    await api.submit(operation, new AbortController().signal, event);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`/api/conversations/${value.conversationId}/messages`);
    expect(options?.method).toBe("POST");
    expect(JSON.parse(options?.body as string)).toEqual({
      message: "Revenue?", clientMessageId: operation.clientMessageId, expectedRevision: "v1:0:0",
    });
    expect(event).toHaveBeenCalledWith({ kind: "accepted", runId, snapshot: value });
  });

  it("treats stream EOF without a terminal outcome as uncertain delivery", async () => {
    const value = snapshot();
    const event = { kind: "accepted", runId: "1459be9a-0ad9-4c75-a4ba-9fb34e728a5a", snapshot: value } satisfies ChatStreamEvent;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `event: accepted\ndata: ${JSON.stringify(event)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const api = createChatApi(fetcher);
    const operation: PendingOperation = {
      kind: "message", conversationId: value.conversationId,
      clientMessageId: "0b14b98a-42dd-41d8-9c9b-27ddb2e48404", expectedRevision: value.revision, message: "Revenue?",
    };
    await expect(api.submit(operation, new AbortController().signal, () => {})).rejects.toThrow("response was interrupted");
  });
});
