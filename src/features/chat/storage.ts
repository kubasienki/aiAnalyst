import { z } from "zod";
import { messageSubmissionSchema, retrySubmissionSchema } from "../../shared/conversations";

const ACTIVE_KEY = "hockeystack.conversation.v2";
const PENDING_KEY = "hockeystack.pending.v2";
export const pendingOperationSchema = z.discriminatedUnion("kind", [
  messageSubmissionSchema.extend({ kind: z.literal("message"), conversationId: z.uuid() }),
  retrySubmissionSchema.extend({ kind: z.literal("retry"), conversationId: z.uuid(), runId: z.uuid() }),
]);
export type PendingOperation = z.infer<typeof pendingOperationSchema>;

export interface ChatStorage {
  loadActiveId(): string | null;
  saveActiveId(id: string): void;
  loadPending(): PendingOperation | null;
  savePending(operation: PendingOperation): void;
  clearPending(): void;
}

export function createBrowserChatStorage(): ChatStorage {
  // Browser APIs are accessed after mounting or from user actions.
  return {
    loadActiveId() {
      const id = sessionStorage.getItem(ACTIVE_KEY) ?? localStorage.getItem(ACTIVE_KEY);
      return id === null ? null : z.uuid().parse(id);
    },
    saveActiveId(id) {
      sessionStorage.setItem(ACTIVE_KEY, z.uuid().parse(id));
      try {
        localStorage.setItem(ACTIVE_KEY, id);
      } catch {
        // This tab retains its identity; a new tab may start empty.
      }
    },
    loadPending() {
      const encoded = sessionStorage.getItem(PENDING_KEY);
      if (encoded === null) {
        return null;
      }
      const value: unknown = JSON.parse(encoded);
      return pendingOperationSchema.parse(value);
    },
    savePending(operation) {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingOperationSchema.parse(operation)));
    },
    clearPending() {
      sessionStorage.removeItem(PENDING_KEY);
    },
  };
}
