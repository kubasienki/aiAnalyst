import "server-only";

export type ModelErrorCode =
  | "configuration" | "invalid_request" | "provider" | "invalid_response"
  | "truncated" | "filtered" | "response_limit" | "timeout" | "deadline"
  | "cancelled" | "context_limit" | "replay_mismatch";

export class ModelError extends Error {
  constructor(public readonly code: ModelErrorCode, message: string) {
    super(message);
    this.name = "ModelError";
  }
}
