import { DataQueryError } from "../../data/errors";
import type { JsonValue, QueryColumn } from "../../data/types";

function invalid(): never {
  throw new DataQueryError("execution_failed", "BigQuery returned an unsupported result value.");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  const wrapped = object(value).value;
  return typeof wrapped === "string" ? wrapped : invalid();
}

function normalizeValue(value: unknown, column: QueryColumn): JsonValue {
  if (value === null) return null;
  if (column.mode === "REPEATED") {
    if (!Array.isArray(value)) return invalid();
    return value.map(item => normalizeValue(item, { ...column, mode: "NULLABLE" }));
  }
  switch (column.type) {
    case "RECORD": case "STRUCT":
      return normalizeRow(object(value), column.fields || []);
    case "INTEGER": case "INT64": {
      if (typeof value === "number" && !Number.isSafeInteger(value)) return invalid();
      const text = typeof value === "number" ? String(value) : scalar(value);
      if (!/^-?\d+$/.test(text)) return invalid();
      const integer = BigInt(text);
      return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(integer) : text;
    }
    case "NUMERIC": case "BIGNUMERIC": {
      // The SDK returns exact decimal objects; never coerce them to JS numbers.
      const text = typeof value === "string" ? value : object(value).toString?.call(value);
      return typeof text === "string" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? text : invalid();
    }
    case "FLOAT": case "FLOAT64":
      return typeof value === "number" && Number.isFinite(value) ? value : invalid();
    case "BOOL": case "BOOLEAN":
      return typeof value === "boolean" ? value : invalid();
    case "DATE": case "DATETIME": case "TIME": case "TIMESTAMP":
      return scalar(value);
    case "BYTES":
      return Buffer.isBuffer(value) ? value.toString("base64") : invalid();
    case "STRING": case "GEOGRAPHY": case "JSON":
      return typeof value === "string" ? value : invalid();
    default:
      return invalid();
  }
}

export function normalizeRow(row: Record<string, unknown>, columns: QueryColumn[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null);
  for (const column of columns) result[column.name] = normalizeValue(row[column.name], column);
  return result;
}
