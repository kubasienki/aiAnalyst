import type { ConversationSnapshot } from "../../shared/conversations";
import type { PendingOperation } from "./storage";

type ReconciliationInput = {
  pendingOperation: PendingOperation | null;
  snapshot: ConversationSnapshot;
  draft: string;
  submissionInFlight: boolean;
};

type ReconciliationDecision =
  | { kind: "no_pending_operation" }
  | { kind: "submission_in_flight" }
  | { kind: "accepted"; draft: string }
  | { kind: "stale_revision"; draft: string }
  | { kind: "recoverable"; operation: PendingOperation };

// Decide recovery from authoritative history. Storage and UI updates belong to
// the controller; an uncertain delivery never grants permission to auto-resend.
export function reconcilePendingOperation(input: ReconciliationInput): ReconciliationDecision {
  const pending = input.pendingOperation;
  if (!pending) {
    return { kind: "no_pending_operation" };
  }
  const accepted = input.snapshot.turns.some(turn =>
    turn.attempts.some(attempt => attempt.clientMessageId === pending.clientMessageId),
  );
  if (accepted) {
    let draft = input.draft;
    if (pending.kind === "message" && draft === pending.message) {
      draft = "";
    }
    return { kind: "accepted", draft };
  }
  if (input.submissionInFlight) {
    return { kind: "submission_in_flight" };
  }
  if (pending.expectedRevision !== input.snapshot.revision) {
    let draft = input.draft;
    if (pending.kind === "message") {
      draft = pending.message;
    }
    return { kind: "stale_revision", draft };
  }
  return { kind: "recoverable", operation: pending };
}
