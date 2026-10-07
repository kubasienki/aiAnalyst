export const MAX_USER_MESSAGE_LENGTH = 2_000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 16_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
