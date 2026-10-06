import { describe, expect, it } from "vitest";
import { parseChatRequest } from "../../shared/chat";
import { appendUserMessage, selectChatContext } from "./conversation";
import type { ChatMessage } from "./types";

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content };
}

describe("conversation context", () => {
  it("preserves an unanswered question when a follow-up is sent", () => {
    const question = message("1", "user", "Explain conversion");
    const followUp = message("2", "user", "Use a simple example");
    const history = appendUserMessage([question], followUp);
    expect(history).toEqual([question, followUp]);
    expect(selectChatContext(history)).toEqual([question, followUp]);
    expect(parseChatRequest({ messages: selectChatContext(history) })).toHaveLength(2);
  });

  it("drops older exchanges to meet the character budget without losing the current question", () => {
    const history: ChatMessage[] = [];
    for (let index = 0; index < 5; index++) {
      history.push(message(`u${index}`, "user", "x".repeat(2_000)));
      history.push(message(`a${index}`, "assistant", "x".repeat(16_000)));
    }
    const question = message("latest", "user", "What about mobile?");
    history.push(question);
    const context = selectChatContext(history);
    expect(context).toEqual(history.slice(4));
    expect(context.at(-1)).toBe(question);
    expect(() => parseChatRequest({ messages: context })).not.toThrow();
  });

  it("preserves consecutive user questions during trimming instead of assuming pairs", () => {
    const history = [
      message("old", "user", "Old question"),
      ...Array.from({ length: 4 }, (_, index) => message(`a${index}`, "assistant", "x".repeat(16_000))),
      message("failed", "user", "Explain conversion"),
      message("follow-up", "user", "Use a simple example"),
    ];
    expect(selectChatContext(history)).toEqual(history.slice(-2));
  });

  it("reserves a reply slot and drops an orphan assistant reply from context", () => {
    const history = Array.from({ length: 40 }, (_, index) => message(String(index), index % 2 === 0 ? "user" : "assistant", "Hello"));
    const next = appendUserMessage(history, message("latest", "user", "Next"));
    expect(next).toHaveLength(39);
    expect(next[0].id).toBe("2");
    expect(selectChatContext(history.slice(1))[0].role).toBe("user");
  });
});
