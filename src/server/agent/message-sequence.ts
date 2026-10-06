// Sequence validation is independent of provider serialization and persistence.
export type MessageSequenceEntry =
  | { role: "assistant"; toolCalls: readonly { callId: string }[] }
  | { role: "tool"; callId: string }
  | { role: "system" | "user" };

export function inspectMessageSequence(messages: readonly MessageSequenceEntry[]):
  | { valid: false }
  | { valid: true; pendingCallIds: ReadonlySet<string> } {
  const pendingCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pendingCallIds.delete(message.callId)) {
        return { valid: false };
      }
      continue;
    }
    if (pendingCallIds.size > 0) {
      return { valid: false };
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        if (pendingCallIds.has(call.callId)) {
          return { valid: false };
        }
        pendingCallIds.add(call.callId);
      }
    }
  }
  return { valid: true, pendingCallIds };
}
