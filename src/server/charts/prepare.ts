import "server-only";
import {
  answerChartsSchema, chartSelectedColumns, chartValueFields,
  MAX_ANSWER_CHART_BYTES, MAX_CHART_ROWS,
  MAX_CATEGORY_CHART_ROWS, MAX_FUNNEL_STAGES, MAX_HISTOGRAM_BINS, MAX_CATEGORY_LABEL_LENGTH,
  type ChartCell, type ChartSpec, type ResolvedChart,
} from "../../shared/charts";
import type { QueryColumn, QueryEvidence } from "../data/types";

type ChartFailure = {
  code: "invalid_chart" | "chart_limit";
  message: string;
  chartIndex: number;
};

export type ChartPreparationResult =
  | { ok: true; charts: ResolvedChart[] }
  | { ok: false; error: ChartFailure };

export type ChartEvidenceLookup = (evidenceId: string) => QueryEvidence | undefined;

class ChartValidationError extends Error {}

function reject(message: string): never {
  throw new ChartValidationError(message);
}

const numericTypes = new Set(["INTEGER", "INT64", "NUMERIC", "BIGNUMERIC", "FLOAT", "FLOAT64"]);
const categoryTypes = new Set(["STRING", "INTEGER", "INT64", "DATE"]);
const decimalPattern = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function requireColumn(columns: QueryColumn[], name: string, allowedTypes: ReadonlySet<string>): QueryColumn {
  const matches = columns.filter(column => column.name === name);
  if (matches.length !== 1 || matches[0].mode === "REPEATED" || !allowedTypes.has(matches[0].type)) {
    reject(`Column '${name}' must be a unique scalar column of the required type.`);
  }
  return matches[0];
}

// Coordinates are approximate; resolved rows retain the original exact values.
// Large integer coordinates would collapse distinct points, so reject them.
function plottingNumber(value: ChartCell): number {
  if (value === null || (typeof value === "string" && !decimalPattern.test(value))) {
    reject("Numeric chart values must be finite numbers or exact decimal strings.");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    reject("Numeric chart values exceed the supported plotting range.");
  }
  if (number === 0 && typeof value === "string" && /[1-9]/.test(value.split(/[eE]/)[0])) {
    reject("Numeric chart values are too small to represent as plotting coordinates.");
  }
  return number;
}

function selectRows(spec: ChartSpec, evidence: QueryEvidence): ResolvedChart["rows"] {
  const selectedColumns = chartSelectedColumns(spec);
  return evidence.rows.map(source => {
    const selected: Record<string, ChartCell> = Object.create(null);
    for (const name of selectedColumns) {
      if (!Object.hasOwn(source, name)) {
        reject(`A row is missing selected column '${name}'.`);
      }
      const value = source[name];
      if (value !== null && typeof value !== "string" && typeof value !== "number") {
        reject(`Column '${name}' must contain scalar chart values.`);
      }
      selected[name] = value;
    }
    return selected;
  });
}

function validateValueFields(spec: ChartSpec, evidence: QueryEvidence, rows: ResolvedChart["rows"]): void {
  const fields = chartValueFields(spec);
  if (new Set(fields.map(field => field.column)).size !== fields.length) {
    reject("Value series must refer to distinct columns.");
  }
  if (spec.type !== "scatter" && new Set(fields.map(field => JSON.stringify(field.format))).size > 1) {
    reject("Series on the same axis must have matching units and value formats.");
  }
  const allowsMissing = spec.type === "line" || spec.type === "bar" || spec.type === "stacked_bar";
  for (const field of fields) {
    requireColumn(evidence.columns, field.column, numericTypes);
    let observed = false;
    for (const row of rows) {
      const value = row[field.column];
      if (value === null && allowsMissing) {
        continue;
      }
      const number = plottingNumber(value);
      observed = true;
      if (spec.type === "stacked_bar" && number < 0) {
        reject("Stacked bars require nonnegative values.");
      }
      if ((spec.type === "funnel" || spec.type === "histogram") && (!Number.isSafeInteger(number) || number < 0)) {
        reject("Histogram and funnel counts must be nonnegative safe integers.");
      }
    }
    if (!observed) {
      reject(`Series '${field.column}' has no observed values.`);
    }
  }
}

function validateCategories(column: string, rows: ResolvedChart["rows"]): void {
  const categories = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (value === null || String(value).trim() === "" || categories.has(String(value))) {
      reject("Category or stage values must be nonempty and unique. Aggregate to one row per category in SQL.");
    }
    categories.add(String(value));
    if (String(value).length > MAX_CATEGORY_LABEL_LENGTH) {
      reject(`Category labels must fit ${MAX_CATEGORY_LABEL_LENGTH} characters for readable axes.`);
    }
  }
}

function validateDates(column: QueryColumn, rows: ResolvedChart["rows"]): void {
  let previous = -Infinity;
  for (const row of rows) {
    const value = row[column.name];
    if (typeof value !== "string") {
      reject("Time-series dates must be nonnull strings.");
    }
    if (column.type === "DATE" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      reject("DATE chart values must use YYYY-MM-DD.");
    }
    if (column.type === "TIMESTAMP" && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      reject("TIMESTAMP chart values must include an explicit timezone.");
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= previous) {
      reject("Time-series dates must be valid, unique, and ordered chronologically in SQL.");
    }
    if (column.type === "DATE" && new Date(timestamp).toISOString().slice(0, 10) !== value) {
      reject("Time-series dates must be valid calendar dates.");
    }
    previous = timestamp;
  }
}

function nearlyEqual(left: number, right: number): boolean {
  // Accommodate conversion of exact decimal bin boundaries to plotting numbers.
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validateHistogram(spec: Extract<ChartSpec, { type: "histogram" }>, evidence: QueryEvidence, rows: ResolvedChart["rows"]): void {
  requireColumn(evidence.columns, spec.lowerBoundColumn, numericTypes);
  requireColumn(evidence.columns, spec.upperBoundColumn, numericTypes);
  if (chartSelectedColumns(spec).length !== 3) {
    reject("Histogram bounds and count must use distinct columns.");
  }
  let previousUpper: number | undefined;
  let binWidth: number | undefined;
  for (const row of rows) {
    const lower = plottingNumber(row[spec.lowerBoundColumn]);
    const upper = plottingNumber(row[spec.upperBoundColumn]);
    const width = upper - lower;
    if (width <= 0 || (binWidth !== undefined && !nearlyEqual(width, binWidth))) {
      reject("Histogram bins must have positive, equal widths.");
    }
    if (previousUpper !== undefined && !nearlyEqual(lower, previousUpper)) {
      reject("Histogram bins must be contiguous and ordered in SQL.");
    }
    previousUpper = upper;
    binWidth = width;
  }
}

function prepareChart(spec: ChartSpec, evidence: QueryEvidence): ResolvedChart {
  if (evidence.truncated) {
    reject("Charts require complete query results. Obtain a smaller aggregate; do not chart a service-truncated prefix.");
  }
  if (evidence.rows.length === 0 || evidence.rows.length > MAX_CHART_ROWS) {
    reject(`Charts require between 1 and ${MAX_CHART_ROWS} source rows.`);
  }
  if ((spec.type === "bar" || spec.type === "stacked_bar") && evidence.rows.length > MAX_CATEGORY_CHART_ROWS) {
    reject(`Category charts support at most ${MAX_CATEGORY_CHART_ROWS} categories for readability. Request a relevant top-N or stronger aggregation.`);
  }
  if (spec.type === "funnel" && evidence.rows.length > MAX_FUNNEL_STAGES) {
    reject(`Funnels support at most ${MAX_FUNNEL_STAGES} stages for readability.`);
  }
  if (spec.type === "histogram" && evidence.rows.length > MAX_HISTOGRAM_BINS) {
    reject(`Histograms support at most ${MAX_HISTOGRAM_BINS} bins for readability. Request wider equal-width bins.`);
  }
  const rows = selectRows(spec, evidence);
  validateValueFields(spec, evidence, rows);
  switch (spec.type) {
    case "line": {
      if (spec.series.some(field => field.column === spec.x.column)) {
        reject("The time axis and value series must use distinct columns.");
      }
      const column = requireColumn(evidence.columns, spec.x.column, new Set(["DATE", "TIMESTAMP"]));
      validateDates(column, rows);
      break;
    }
    case "bar":
    case "stacked_bar":
      if (spec.series.some(field => field.column === spec.x.column)) {
        reject("The category axis and value series must use distinct columns.");
      }
      requireColumn(evidence.columns, spec.x.column, categoryTypes);
      validateCategories(spec.x.column, rows);
      break;
    case "scatter":
      if (spec.pointLabelColumn) {
        requireColumn(evidence.columns, spec.pointLabelColumn, categoryTypes);
      }
      break;
    case "histogram":
      validateHistogram(spec, evidence, rows);
      break;
    case "funnel": {
      if (spec.stage.column === spec.count.column) {
        reject("Funnel stages and counts must use distinct columns.");
      }
      requireColumn(evidence.columns, spec.stage.column, categoryTypes);
      validateCategories(spec.stage.column, rows);
      let previous = Infinity;
      for (const row of rows) {
        const count = plottingNumber(row[spec.count.column]);
        if (count > previous) {
          reject("Funnel counts must not increase through the supplied stages.");
        }
        previous = count;
      }
      break;
    }
  }
  return { kind: "ready", spec, rows };
}

export function prepareAnswerCharts(
  specs: ChartSpec[],
  referencedEvidenceIds: readonly string[],
  lookupEvidence: ChartEvidenceLookup,
): ChartPreparationResult {
  const parsed = answerChartsSchema.safeParse(specs);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_chart",
        message: "Charts must match the supported specification and limits.",
        chartIndex: 0,
      },
    };
  }
  const charts: ResolvedChart[] = [];
  for (const [chartIndex, spec] of parsed.data.entries()) {
    try {
      if (!referencedEvidenceIds.includes(spec.evidenceId)) {
        reject("Each chart must reference evidence included in the answer's evidenceIds.");
      }
      const evidence = lookupEvidence(spec.evidenceId);
      if (!evidence || evidence.resultId !== spec.evidenceId) {
        reject("Chart evidence must belong to this conversation and be available to this analysis.");
      }
      charts.push(prepareChart(spec, evidence));
    } catch (error) {
      if (!(error instanceof ChartValidationError)) {
        throw error;
      }
      return {
        ok: false,
        error: {
          code: "invalid_chart",
          message: `Chart ${chartIndex + 1}: ${error.message}`,
          chartIndex,
        },
      };
    }
    if (Buffer.byteLength(JSON.stringify(charts), "utf8") > MAX_ANSWER_CHART_BYTES) {
      return {
        ok: false,
        error: {
          code: "chart_limit",
          message: "Combined chart data exceeds 64 KiB. Select fewer series or request stronger SQL aggregation.",
          chartIndex,
        },
      };
    }
  }
  return { ok: true, charts };
}
