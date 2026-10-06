import { describe, expect, it } from "vitest";
import { normalizeRow } from "./normalize";

describe("BigQuery normalization", () => {
  it("preserves exact integers, decimals, dates, nulls, and nested arrays", () => {
    const columns = [
      { name: "small", type: "INTEGER" }, { name: "large", type: "INTEGER" },
      { name: "decimal", type: "NUMERIC" }, { name: "date", type: "DATE" },
      { name: "nullable", type: "FLOAT" }, { name: "items", type: "RECORD", mode: "REPEATED", fields: [{ name: "name", type: "STRING" }] },
    ];
    const result = normalizeRow({ small: { value: "12" }, large: { value: "9007199254740993" }, decimal: { toString: () => "123.4567890123456789" }, date: { value: "2020-12-01" }, nullable: null, items: [{ name: "shirt" }] }, columns);
    expect(result).toEqual({ small: 12, large: "9007199254740993", decimal: "123.4567890123456789", date: "2020-12-01", nullable: null, items: [{ name: "shirt" }] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it("rejects non-finite and unsupported values rather than silently altering them", () => {
    expect(() => normalizeRow({ n: Infinity }, [{ name: "n", type: "FLOAT" }])).toThrow();
    expect(() => normalizeRow({ n: 9007199254740992 }, [{ name: "n", type: "INTEGER" }])).toThrow();
    expect(() => normalizeRow({ n: {} }, [{ name: "n", type: "UNKNOWN" }])).toThrow();
  });
});
