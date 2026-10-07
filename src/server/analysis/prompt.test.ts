import { describe, expect, it } from "vitest";
import { DATASET_SCHEMA } from "../data/dataset-schema";
import { REFERENCE_QUERIES } from "../data/reference-queries";
import { SEMANTIC_GUIDE } from "../data/semantic-guide";
import { validateSql } from "../data/sql-policy";
import { buildAnalystInstructions } from "./prompt";

describe("verified analyst knowledge", () => {
  it("supplies a stable complete schema/definition prefix without prefilled metric totals", () => {
    const instructions = buildAnalystInstructions();
    expect(buildAnalystInstructions()).toEqual(instructions);
    expect(instructions[2]).not.toContain(DATASET_SCHEMA);
    expect(instructions[1]).toContain("NULL SUM for an unavailable-ID bucket means its amount is unknown/not recorded");
    expect(DATASET_SCHEMA).toContain("event_params: RECORD[]");
    expect(DATASET_SCHEMA).toContain("stream_id: INTEGER");
    expect(DATASET_SCHEMA).not.toContain("is_active_user:");
    expect(SEMANTIC_GUIDE).not.toContain("362165");
    expect(SEMANTIC_GUIDE).not.toContain("5692");
    expect(instructions.join("\n")).toContain("inspect_dataset(topic)");
    expect(instructions.join("\n")).not.toContain("event_previous_timestamp: INTEGER");
    expect(instructions[1]).toContain("ga_session_id int_value");
    expect(instructions.join("\n")).toContain("compare intent with the ACTUAL SQL");
  });

  it.each(Object.entries(REFERENCE_QUERIES))("accepts %s under the unchanged production SQL safety policy", (_, sql) => {
    expect(validateSql(sql)).toBe(sql.trim());
  });
});
