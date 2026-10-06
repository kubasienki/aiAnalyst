import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/chat/route";
import { ChatError } from "./chat-service";
import { createChat } from "../config/chat";

vi.mock("../config/chat", () => ({ createChat: vi.fn() }));

describe("POST /api/chat", () => {
  beforeEach(() => vi.clearAllMocks());

  function request(body: unknown) {
    return new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects invalid input before constructing the model", async () => {
    const response = await POST(request({ messages: [{ role: "system", content: "Hi" }] }));
    expect(response.status).toBe(400);
    expect(createChat).not.toHaveBeenCalled();
  });

  it("returns the reply and passes request cancellation to the service", async () => {
    const reply = vi.fn().mockResolvedValue("Hello");
    vi.mocked(createChat).mockReturnValue(reply);
    const incoming = request({ messages: [{ role: "user", content: "Hi" }] });
    const response = await POST(incoming);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "Hello" });
    expect(reply).toHaveBeenCalledWith([{ role: "user", content: "Hi" }], incoming.signal);
  });

  it.each([
    ["configuration", 503],
    ["provider", 502],
    ["timeout", 504],
    ["cancelled", 499],
  ] as const)("maps %s failures to HTTP status %i", async (code, status) => {
    vi.mocked(createChat).mockReturnValue(vi.fn().mockRejectedValue(new ChatError(code, "Safe message")));
    const response = await POST(request({ messages: [{ role: "user", content: "Hi" }] }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Safe message" });
  });

  it("does not expose unexpected internal errors", async () => {
    vi.mocked(createChat).mockImplementation(() => { throw new Error("sensitive internal detail"); });
    const response = await POST(request({ messages: [{ role: "user", content: "Hi" }] }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Chat failed. Please retry." });
  });
});
