import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { answerSchema } from "../../shared/analysis";
import { type ChartSpec } from "../../shared/charts";
import type { QueryEvidence } from "../data/types";
import { prepareAnswerCharts } from "./prepare";
import { projectAnswerCharts } from "./display";

const resultId = randomUUID();
const common = { evidenceId: resultId, title: "Observed pattern", caption: "Comparison over the complete sample period." };
const revenue = { column: "revenue", label: "Revenue", format: { kind: "currency", currency: "USD" } } as const;
const count = { column: "count", label: "Sessions", format: { kind: "number" } } as const;
const specs: ChartSpec[] = [
  { ...common, type: "line", x: { column: "date", label: "Date" }, series: [revenue] },
  { ...common, type: "bar", x: { column: "label", label: "Category" }, series: [revenue] },
  { ...common, type: "stacked_bar", x: { column: "label", label: "Category" }, series: [revenue, { ...revenue, column: "profit", label: "Profit" }] },
  { ...common, type: "scatter", x: { column: "lower", label: "Spend", format: { kind: "number" } }, y: revenue, pointLabelColumn: "label" },
  { ...common, type: "histogram", lowerBoundColumn: "lower", upperBoundColumn: "upper", xLabel: "Order value", count },
  { ...common, type: "funnel", stage: { column: "label", label: "Stage" }, count },
];

function evidence(overrides: Partial<QueryEvidence> = {}): QueryEvidence {
  const columns = [
    { name: "date", type: "DATE" }, { name: "label", type: "STRING" },
    { name: "revenue", type: "NUMERIC" }, { name: "profit", type: "NUMERIC" },
    { name: "lower", type: "FLOAT" }, { name: "upper", type: "FLOAT" },
    { name: "count", type: "INTEGER" }, { name: "private", type: "STRING" },
  ];
  const rows = [
    { date: "2020-12-01", label: "First", revenue: "1250.50", profit: "10.25", lower: 0, upper: 10, count: 20, private: "not for the browser" },
    { date: "2020-12-02", label: "Second", revenue: "1480.00", profit: "20.00", lower: 10, upper: 20, count: 10, private: "not for the browser" },
  ];
  const result = {
    resultId, sql: "SELECT private_sql", columns, rows,
    payloadBytes: 0, truncated: false, jobId: "private-job", estimatedBytes: "100",
    statistics: { bytesProcessed: "100", bytesBilled: "100", cacheHit: false },
    elapsedMs: 1, semanticGuideVersion: "test", ...overrides,
  };
  result.payloadBytes = Buffer.byteLength(JSON.stringify({ columns: result.columns, rows: result.rows }), "utf8");
  return result;
}

function prepare(spec: ChartSpec = specs[0], result = evidence()) {
  return prepareAnswerCharts([spec], [resultId], id => id === result.resultId ? result : undefined);
}

describe("chart evidence preparation", () => {
  it("keeps checkout transitions in supplied journey order, including undefined rates", () => {
    const spec: ChartSpec = {
      ...common, type: "bar", x: { column: "transition", label: "Checkout step" },
      series: [{ column: "rate", label: "Sessions not reaching the next recorded step", format: { kind: "percentage", inputScale: "ratio" } }],
    };
    const source = evidence({
      columns: [{ name: "transition", type: "STRING" }, { name: "rate", type: "FLOAT" }],
      rows: [
        { transition: "Checkout to shipping details", rate: 0.2 },
        { transition: "Shipping details to payment details", rate: 0.25 },
        { transition: "Payment details to recorded purchase", rate: null },
      ],
    });
    expect(prepare(spec, source)).toEqual({ ok: true, charts: [{ kind: "ready", spec, rows: source.rows }] });
  });

  it("preserves negative, zero and positive percentage changes in ordinary bars", () => {
    const spec: ChartSpec = {
      ...common, type: "bar", x: { column: "label", label: "Metric" },
      series: [{ column: "change", label: "Relative change", format: { kind: "percentage", inputScale: "ratio" } }],
    };
    const source = evidence({
      columns: [{ name: "label", type: "STRING" }, { name: "change", type: "FLOAT" }],
      rows: [{ label: "Conversion", change: -0.406 }, { label: "Traffic", change: 0 }, { label: "Purchase value", change: 0.278 }],
    });
    expect(prepare(spec, source)).toEqual({ ok: true, charts: [{ kind: "ready", spec, rows: source.rows }] });
    expect(prepare({ ...spec, type: "stacked_bar" }, source).ok).toBe(false);
  });

  it.each(specs)("extracts a $type chart without copying unrelated evidence", spec => {
    const source = evidence();
    const original = JSON.stringify(source);
    const result = prepare(spec, source);
    expect(result.ok).toBe(true);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("private_sql");
    expect(encoded).not.toContain("private-job");
    expect(encoded).not.toContain("not for the browser");
    expect(JSON.stringify(source)).toBe(original);
  });

  it("preserves exact values, row order, pairing and missing cells", () => {
    const source = evidence();
    source.rows[1].revenue = null;
    expect(prepare(specs[0], source)).toEqual({
      ok: true,
      charts: [{ kind: "ready", spec: specs[0], rows: [
        { date: "2020-12-01", revenue: "1250.50" },
        { date: "2020-12-02", revenue: null },
      ] }],
    });
  });

  it("requires referenced, visible evidence and avoids evidence lookup for text answers", () => {
    expect(prepare({ ...specs[0], evidenceId: randomUUID() })).toMatchObject({ ok: false, error: { code: "invalid_chart" } });
    expect(prepareAnswerCharts([specs[0]], [resultId], () => undefined)).toMatchObject({ ok: false });
    expect(prepareAnswerCharts([specs[0]], [], () => evidence())).toMatchObject({ ok: false });
    const lookup = vi.fn();
    expect(prepareAnswerCharts([], [], lookup)).toEqual({ ok: true, charts: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects unsupported columns, repeated fields, nonnumeric values and unsafe coordinates", () => {
    const source = evidence();
    expect(prepare(specs[0], { ...source, columns: source.columns.filter(column => column.name !== "revenue") }).ok).toBe(false);
    expect(prepare(specs[0], { ...source, columns: source.columns.map(column => ({ ...column, mode: "REPEATED" })) }).ok).toBe(false);
    for (const value of ["nonsense", "9007199254740993", Infinity, { value: 1 }]) {
      expect(prepare(specs[0], evidence({ rows: [{ date: "2020-12-01", revenue: value }] })).ok).toBe(false);
    }
    expect(prepare(specs[0], evidence({ rows: [{ date: "2020-12-01" }] })).ok).toBe(false);
    expect(prepare(specs[0], evidence({ rows: [{ date: "2020-12-01", revenue: null }] })).ok).toBe(false);
  });

  it("rejects empty, oversized and service-truncated results", () => {
    expect(prepare(specs[0], evidence({ rows: [] })).ok).toBe(false);
    expect(prepare(specs[0], evidence({ rows: Array.from({ length: 201 }, () => ({ date: "2020-12-01", revenue: "1" })) })).ok).toBe(false);
    expect(prepare(specs[0], evidence({ truncated: true, truncationReason: "row_limit" })).ok).toBe(false);
  });

  it("requires valid ordered unique dates and nonempty unique categories", () => {
    const source = evidence();
    expect(prepare(specs[0], evidence({ rows: [...source.rows].reverse() })).ok).toBe(false);
    expect(prepare(specs[0], evidence({ rows: [source.rows[0], source.rows[0]] })).ok).toBe(false);
    expect(prepare(specs[0], evidence({ rows: [{ date: "2020-02-30", revenue: "1" }] })).ok).toBe(false);
    expect(prepare(specs[1], evidence({ rows: [{ label: "", revenue: "1" }] })).ok).toBe(false);
    expect(prepare(specs[1], evidence({ rows: [source.rows[0], source.rows[0]] })).ok).toBe(false);
  });

  it("requires timezone-qualified timestamps", () => {
    const columns = [{ name: "date", type: "TIMESTAMP" }, { name: "revenue", type: "NUMERIC" }];
    expect(prepare(specs[0], evidence({ columns, rows: [{ date: "2020-12-01T12:00:00Z", revenue: "1" }] })).ok).toBe(true);
    expect(prepare(specs[0], evidence({ columns, rows: [{ date: "2020-12-01T12:00:00", revenue: "1" }] })).ok).toBe(false);
  });

  it("rejects mixed formats, duplicate series and negative composition", () => {
    const stacked = specs[2];
    if (stacked.type !== "stacked_bar") throw new Error("Expected stacked fixture");
    expect(prepare({ ...stacked, series: [revenue, { ...revenue, column: "profit", format: { kind: "number" } }] }).ok).toBe(false);
    expect(prepare({ ...stacked, series: [revenue, revenue] }).ok).toBe(false);
    const source = evidence();
    source.rows[0].profit = "-1";
    expect(prepare(stacked, source).ok).toBe(false);
  });

  it("rejects missing scatter coordinates and invalid histogram or funnel shapes", () => {
    const source = evidence();
    source.rows[0].revenue = null;
    expect(prepare(specs[3], source).ok).toBe(false);
    for (const rows of [
      [{ lower: 0, upper: 10, count: 2 }, { lower: 10, upper: 30, count: 1 }],
      [{ lower: 0, upper: 10, count: 2 }, { lower: 20, upper: 30, count: 1 }],
      [{ lower: 10, upper: 0, count: 2 }],
      [{ lower: 0, upper: 10, count: -1 }],
      [{ lower: 0, upper: 10, count: 1.5 }],
    ]) {
      expect(prepare(specs[4], evidence({ rows })).ok).toBe(false);
    }
    expect(prepare(specs[5], evidence({ rows: [{ label: "First", count: 10 }, { label: "Second", count: 20 }] })).ok).toBe(false);
  });

  it("bounds charts, series and the combined UTF-8 display payload", () => {
    expect(prepareAnswerCharts(Array.from({ length: 4 }, () => specs[0]), [resultId], () => evidence()).ok).toBe(false);
    const bar = specs[1];
    if (bar.type !== "bar") throw new Error("Expected bar fixture");
    expect(prepare({ ...bar, series: Array.from({ length: 6 }, () => revenue) }).ok).toBe(false);
    const large = evidence({ rows: Array.from({ length: 30 }, (_, index) => ({
      date: `2020-11-${String(index + 1).padStart(2, "0")}`,
      revenue: `1.${"0".repeat(800)}1`,
    })) });
    expect(prepare(specs[0], large).ok).toBe(true);
    expect(prepareAnswerCharts([specs[0], specs[0], specs[0]], [resultId], () => large))
      .toMatchObject({ ok: false, error: { code: "chart_limit" } });
  });

  it("rejects crowded categories, long labels, excessive bins and stages instead of cutting off data", () => {
    expect(prepare(specs[1], evidence({ rows: Array.from({ length: 21 }, (_, index) => ({ label: String(index), revenue: "1" })) })).ok).toBe(false);
    expect(prepare(specs[1], evidence({ rows: [{ label: "x".repeat(121), revenue: "1" }] })).ok).toBe(false);
    expect(prepare(specs[4], evidence({ rows: Array.from({ length: 41 }, (_, index) => ({ lower: index, upper: index + 1, count: 1 })) })).ok).toBe(false);
    expect(prepare(specs[5], evidence({ rows: Array.from({ length: 9 }, (_, index) => ({ label: String(index), count: 10 - index })) })).ok).toBe(false);
  });

  it("rejects arbitrary code/options and reads old answers without charts", () => {
    const executableSpec = { ...specs[0], code: "alert(1)" };
    expect(prepare(executableSpec).ok).toBe(false);
    expect(answerSchema.parse({ narrative: "Old answer", assumptions: [], limitations: [], evidenceIds: [], completeness: "complete" }).charts).toBeUndefined();
  });
});

describe("chart display failures", () => {
  it("keeps the answer independent of missing evidence and reports safe diagnostics", () => {
    const report = vi.fn();
    const answer = answerSchema.parse({ narrative: "Saved finding", assumptions: [], limitations: [], evidenceIds: [resultId], completeness: "complete", charts: [specs[0]] });
    expect(projectAnswerCharts(answer, () => undefined, report)).toEqual([
      { kind: "unavailable", title: common.title, message: "This chart is unavailable. The saved answer is still shown." },
    ]);
    expect(report).toHaveBeenCalledWith("invalid_chart");
    expect(projectAnswerCharts(answer, () => { throw new Error("private storage diagnostic"); }, report)[0].kind).toBe("unavailable");
    expect(report).toHaveBeenCalledWith("chart_projection");
  });
});
