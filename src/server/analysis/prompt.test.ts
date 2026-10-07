import { describe, expect, it } from "vitest";
import { DATASET_SCHEMA } from "../data/dataset-schema";
import { REFERENCE_QUERIES } from "../data/reference-queries";
import { SEMANTIC_GUIDE } from "../data/semantic-guide";
import { validateSql } from "../data/sql-policy";
import { buildAnalystInstructions } from "./prompt";
import { MAX_SQL_ATTEMPTS } from "../data/execution-context";
import { DEFAULT_AGENT_LIMITS } from "../agent/runner";
import { MAX_ANSWER_CHARTS, MAX_CHART_ROWS, MAX_CHART_SERIES, MAX_ANSWER_CHART_BYTES } from "../../shared/charts";

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

  it("states the limits the application enforces, each behavior rule once", () => {
    const behavior = buildAnalystInstructions()[0];
    expect(behavior).toContain(`${MAX_SQL_ATTEMPTS} SQL attempts, ${DEFAULT_AGENT_LIMITS.maxModelRequests} model calls`);
    expect(behavior).toContain(`up to ${MAX_ANSWER_CHARTS} charts`);
    expect(behavior).toContain(`${MAX_CHART_SERIES} series per chart, ${MAX_CHART_ROWS} rows`);
    expect(behavior).toContain(`${MAX_ANSWER_CHART_BYTES / 1024} KiB combined payload`);
    for (const rule of [/markdown/gi, /EXACT saved title/g, /narrow a clear question/g]) {
      expect(behavior.match(rule)).toHaveLength(1);
    }
  });

  it.each(Object.entries(REFERENCE_QUERIES))("accepts %s under the unchanged production SQL safety policy", (_, sql) => {
    expect(validateSql(sql)).toBe(sql.trim());
  });
});
