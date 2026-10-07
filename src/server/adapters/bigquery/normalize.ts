import { DataQueryError } from "../../data/errors";
import type { JsonValue, QueryColumn } from "../../data/types";

function invalidResultValue(): never {
  throw new DataQueryError("execution_failed", "BigQuery returned an unsupported result value.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidResultValue();
  }
  return value;
}

function readScalarString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const wrapped = readRecord(value).value;
  if (typeof wrapped !== "string") {
    return invalidResultValue();
  }
  return wrapped;
}

function normalizeInteger(value: unknown): number | string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return invalidResultValue();
  }
  const text = typeof value === "number" ? String(value) : readScalarString(value);
  if (!/^-?\d+$/.test(text)) {
    return invalidResultValue();
  }
  const integer = BigInt(text);
  if (integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(integer);
  }
  return text;
}

function normalizeDecimal(value: unknown): string {
  // SDK decimal objects retain exact values; never coerce them to JS numbers.
  let text: unknown = value;
  if (typeof value !== "string") {
    const decimal = readRecord(value);
    const toString = decimal.toString;
    if (typeof toString !== "function") {
      return invalidResultValue();
    }
    text = toString.call(value);
  }
  if (typeof text !== "string" || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    return invalidResultValue();
  }
  return text;
}

function normalizeValue(value: unknown, column: QueryColumn): JsonValue {
  if (value === null) {
    return null;
  }
  if (column.mode === "REPEATED") {
    if (!Array.isArray(value)) {
      return invalidResultValue();
    }
    return value.map(item => normalizeValue(item, { ...column, mode: "NULLABLE" }));
  }
  switch (column.type) {
    case "RECORD":
    case "STRUCT":
      return normalizeRow(readRecord(value), column.fields || []);
    case "INTEGER":
    case "INT64":
      return normalizeInteger(value);
    case "NUMERIC":
    case "BIGNUMERIC":
      return normalizeDecimal(value);
    case "FLOAT":
    case "FLOAT64":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalidResultValue();
      }
      return value;
    case "BOOL":
    case "BOOLEAN":
      if (typeof value !== "boolean") {
        return invalidResultValue();
      }
      return value;
    case "DATE":
    case "DATETIME":
    case "TIME":
    case "TIMESTAMP":
      return readScalarString(value);
    case "BYTES":
      if (!Buffer.isBuffer(value)) {
        return invalidResultValue();
      }
      return value.toString("base64");
    case "STRING":
    case "GEOGRAPHY":
    case "JSON":
      if (typeof value !== "string") {
        return invalidResultValue();
      }
      return value;
    default:
      return invalidResultValue();
  }
}

export function normalizeRow(row: Record<string, unknown>, columns: QueryColumn[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null);
  for (const column of columns) {
    result[column.name] = normalizeValue(row[column.name], column);
  }
  return result;
}
