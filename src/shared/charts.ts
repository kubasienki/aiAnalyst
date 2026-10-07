import { z } from "zod";

// Per-answer limits apply to resolved data as well as agent specifications.
export const MAX_ANSWER_CHARTS = 3;
export const MAX_CHART_SERIES = 5;
export const MAX_CHART_ROWS = 200;
export const MAX_ANSWER_CHART_BYTES = 64 * 1024;
export const MAX_CATEGORY_CHART_ROWS = 20;
export const MAX_FUNNEL_STAGES = 8;
export const MAX_HISTOGRAM_BINS = 40;
export const MAX_CATEGORY_LABEL_LENGTH = 120;

const label = z.string().trim().min(1).max(300);
const columnName = z.string().min(1).max(300);

export const valueFormatSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("number") }),
  z.strictObject({ kind: z.literal("currency"), currency: z.string().regex(/^[A-Z]{3}$/) }),
  z.strictObject({ kind: z.literal("percentage"), inputScale: z.enum(["ratio", "percent"]) }),
]);

const categoryFieldSchema = z.strictObject({ column: columnName, label });
const valueFieldSchema = categoryFieldSchema.extend({ format: valueFormatSchema });
const countFieldSchema = categoryFieldSchema.extend({
  format: z.strictObject({ kind: z.literal("number") }),
});
const commonFields = {
  evidenceId: z.uuid(),
  title: label,
  caption: z.string().trim().min(1).max(1_000),
};

export const chartSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...commonFields,
    type: z.literal("line"),
    x: categoryFieldSchema,
    series: z.array(valueFieldSchema).min(1).max(MAX_CHART_SERIES),
  }),
  z.strictObject({
    ...commonFields,
    type: z.literal("bar"),
    x: categoryFieldSchema,
    series: z.array(valueFieldSchema).min(1).max(MAX_CHART_SERIES),
  }),
  z.strictObject({
    ...commonFields,
    type: z.literal("stacked_bar"),
    x: categoryFieldSchema,
    series: z.array(valueFieldSchema).min(1).max(MAX_CHART_SERIES),
  }),
  z.strictObject({
    ...commonFields,
    type: z.literal("scatter"),
    x: valueFieldSchema,
    y: valueFieldSchema,
    pointLabelColumn: columnName.optional(),
  }),
  z.strictObject({
    ...commonFields,
    type: z.literal("histogram"),
    lowerBoundColumn: columnName,
    upperBoundColumn: columnName,
    xLabel: label,
    count: countFieldSchema,
  }),
  z.strictObject({
    ...commonFields,
    type: z.literal("funnel"),
    stage: categoryFieldSchema,
    count: countFieldSchema,
  }),
]);

export const answerChartsSchema = z.array(chartSpecSchema).max(MAX_ANSWER_CHARTS);
export const chartCellSchema = z.union([z.string(), z.number().finite(), z.null()]);
export const resolvedChartSchema = z.strictObject({
  kind: z.literal("ready"),
  spec: chartSpecSchema,
  rows: z.array(z.record(z.string(), chartCellSchema)).min(1).max(MAX_CHART_ROWS),
});
export const chartDisplayResultSchema = z.discriminatedUnion("kind", [
  resolvedChartSchema,
  z.strictObject({
    kind: z.literal("unavailable"),
    title: label,
    message: z.literal("This chart is unavailable. The saved answer is still shown."),
  }),
]);

export type ValueFormat = z.infer<typeof valueFormatSchema>;
export type ValueField = z.infer<typeof valueFieldSchema>;
export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ChartCell = z.infer<typeof chartCellSchema>;
export type ResolvedChart = z.infer<typeof resolvedChartSchema>;
export type ChartDisplayResult = z.infer<typeof chartDisplayResultSchema>;

export function chartValueFields(spec: ChartSpec): ValueField[] {
  switch (spec.type) {
    case "line":
    case "bar":
    case "stacked_bar":
      return spec.series;
    case "scatter":
      return [spec.x, spec.y];
    case "histogram":
    case "funnel":
      return [spec.count];
  }
}

export function chartSelectedColumns(spec: ChartSpec): string[] {
  const values = chartValueFields(spec).map(field => field.column);
  switch (spec.type) {
    case "line":
    case "bar":
    case "stacked_bar":
      return [...new Set([spec.x.column, ...values])];
    case "scatter":
      return [...new Set([...values, ...(spec.pointLabelColumn ? [spec.pointLabelColumn] : [])])];
    case "histogram":
      return [...new Set([spec.lowerBoundColumn, spec.upperBoundColumn, ...values])];
    case "funnel":
      return [...new Set([spec.stage.column, ...values])];
  }
}
