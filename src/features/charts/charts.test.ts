import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResolvedChart } from "../../shared/charts";
import { AnswerChart, ChartRenderBoundary } from "./AnswerChart";
import { ChartTooltip } from "./ChartTooltip";
import { formatChartTick, formatChartValue } from "./format";
import { buildPlotRows, wrapCategoryLabel } from "./plot-data";

function chart(): ResolvedChart {
  return {
    kind: "ready",
    spec: {
      type: "line", evidenceId: randomUUID(), title: "Daily revenue", caption: "USD revenue over the sample period.",
      x: { column: "date", label: "Date" },
      series: [{ column: "revenue", label: "Revenue", format: { kind: "currency", currency: "USD" } }],
    },
    rows: [{ date: "2020-12-01", revenue: "1.005" }, { date: "2020-12-03", revenue: null }],
  };
}

describe("chart presentation", () => {
  it("preserves and formats signed percentage changes without losing zero", () => {
    const source: ResolvedChart = {
      kind: "ready",
      spec: {
        type: "bar", evidenceId: randomUUID(), title: "Relative metric changes",
        caption: "Relative changes are not additive contributions to revenue.",
        x: { column: "metric", label: "Metric" },
        series: [{ column: "change", label: "Change", format: { kind: "percentage", inputScale: "ratio" } }],
      },
      rows: [{ metric: "Conversion", change: -0.406 }, { metric: "Traffic", change: 0 }, { metric: "Purchase value", change: 0.278 }],
    };
    if (source.spec.type !== "bar") throw new Error("Expected bar chart");
    expect(buildPlotRows(source).map(row => row.values[0])).toEqual([-0.406, 0, 0.278]);
    expect(formatChartTick(-0.406, source.spec.series[0].format)).toBe("-40.6%");
    expect(formatChartValue(0, source.spec.series[0].format)).toBe("0%");
    expect(formatChartValue(27.8, { kind: "percentage", inputScale: "percent" })).toBe("27.8%");
    const tooltip = renderToStaticMarkup(createElement(ChartTooltip, {
      spec: source.spec, active: true, payload: [{ payload: buildPlotRows(source)[0] }],
    }));
    expect(tooltip).toContain("-40.6%");
  });

  it("formats original decimals, currencies, percentages and missing values", () => {
    expect(formatChartValue("1.005", { kind: "currency", currency: "USD" })).toBe("$1.01");
    expect(formatChartValue("0.125", { kind: "percentage", inputScale: "ratio" })).toBe("12.5%");
    expect(formatChartValue("12.5", { kind: "percentage", inputScale: "percent" })).toBe("12.5%");
    expect(formatChartValue("1234.56", { kind: "number" })).toBe("1,234.56");
    expect(formatChartValue(null, { kind: "number" })).toBe("Missing");
  });

  it("exports a callable axis formatter and keeps large ticks concise", () => {
    expect(formatChartTick(12000, { kind: "currency", currency: "USD" })).toBe("$12K");
    expect(formatChartTick(12500, { kind: "number" })).toBe("12.5K");
    expect(formatChartTick(0.125, { kind: "percentage", inputScale: "ratio" })).toBe("12.5%");
  });

  it("keeps original values and null gaps while mapping to numeric coordinates", () => {
    const source = chart();
    const rows = buildPlotRows(source);
    expect(rows[0]).toEqual({ label: "2020-12-01", values: [1.005], time: 1606780800000, original: { date: "2020-12-01", revenue: "1.005" } });
    expect(rows[1].values).toEqual([null]);
    const firstTime = rows[0].time;
    const secondTime = rows[1].time;
    if (firstTime === undefined || secondTime === undefined) throw new Error("Expected time coordinates");
    expect(secondTime - firstTime).toBe(2 * 24 * 60 * 60 * 1_000);
    expect(source.rows[0].revenue).toBe("1.005");
  });

  it("wraps long category labels without dropping words or characters", () => {
    expect(wrapCategoryLabel("Paid search returning customers")).toEqual(["Paid search", "returning", "customers"]);
    expect(wrapCategoryLabel("VeryLongCategoryLabelWithoutSpaces").join("")).toBe("VeryLongCategoryLabelWithoutSpaces");
  });

  it("provides a titled, described chart and a keyboard-accessible exact-value table", () => {
    const markup = renderToStaticMarkup(createElement(AnswerChart, { chart: chart() }));
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain("View data");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Revenue (USD)");
    expect(markup).toContain("1.005");
    expect(markup).toContain("Missing");
  });

  it("escapes untrusted labels in headings, tables and tooltips", () => {
    const source = chart();
    source.spec.title = "<script>alert(1)</script>";
    source.rows[0].date = "<img src=x onerror=alert(1)>";
    // A category chart keeps this value as a label rather than a date coordinate.
    source.spec.type = "bar";
    const markup = renderToStaticMarkup(createElement(AnswerChart, { chart: source }));
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
    const tooltip = renderToStaticMarkup(createElement(ChartTooltip, {
      spec: source.spec, active: true, payload: [{ payload: buildPlotRows(source)[0] }],
    }));
    expect(tooltip).toContain("&lt;img");
    expect(tooltip).toContain("Original: 1.005");
  });

  it("contains chart rendering failures and renders projection failures without a plot", () => {
    expect(ChartRenderBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new ChartRenderBoundary({ children: createElement("span", null, "chart") });
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render())).toContain("You can still view its data below");
    const markup = renderToStaticMarkup(createElement(AnswerChart, { chart: {
      kind: "unavailable", title: "Saved chart", message: "This chart is unavailable. The saved answer is still shown.",
    } }));
    expect(markup).toContain("Saved chart");
    expect(markup).not.toContain("View data");
  });
});
