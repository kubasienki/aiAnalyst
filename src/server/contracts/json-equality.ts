import "server-only";
import { jsonValueSchema, type JsonValue } from "./json";

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  // Optional undefined fields are omitted just as they are in stored JSON.
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  return JSON.stringify(sortJson(jsonValueSchema.parse(normalized)));
}
