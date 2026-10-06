import "server-only";
import type { MessageSequenceEntry } from "../agent/message-sequence";
import type { ConversationEvent } from "./contracts";

// Evidence need not be loaded to validate transcript ordering.
export function transcriptSequence(events: readonly ConversationEvent[]): MessageSequenceEntry[] {
  const messages: MessageSequenceEntry[] = [];
  for (const event of events) {
    const payload = event.payload;
    switch (payload.kind) {
      case "assistant_message":
        messages.push(payload.message);
        break;
      case "tool_result":
        messages.push({ role: "tool", callId: payload.result.callId });
        break;
      case "user_message":
        messages.push({ role: "user" });
        break;
      case "context_note":
        messages.push({ role: "system" });
        break;
      case "outcome":
        // Failed attempts can end with pending calls. Outcomes aren't model messages.
        break;
    }
  }
  return messages;
}
