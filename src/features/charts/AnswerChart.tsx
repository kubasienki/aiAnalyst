"use client";

import dynamic from "next/dynamic";
import { Component, useId, type ReactNode } from "react";
import { chartSelectedColumns, chartValueFields, type ChartDisplayResult, type ResolvedChart } from "../../shared/charts";
import { valueUnitLabel } from "./format";
import { ChartViewport } from "./ChartViewport";
import styles from "./charts.module.css";

const ChartPlot = dynamic(() => import("./ChartPlot"), {
  ssr: false,
  loading: () => <p role="status">Loading chart…</p>,
});

export class ChartRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <p role="status">This chart could not be displayed. You can still view its data below.</p>;
    }
    return this.props.children;
  }
}

function ChartDataTable({ chart }: { chart: ResolvedChart }) {
  const columns = chartSelectedColumns(chart.spec);
  const fields = chartValueFields(chart.spec);
  function columnLabel(column: string): string {
    const field = fields.find(candidate => candidate.column === column);
    if (field) {
      const unit = valueUnitLabel(field.format);
      return unit ? `${field.label} (${unit})` : field.label;
    }
    if ((chart.spec.type === "line" || chart.spec.type === "bar" || chart.spec.type === "stacked_bar") && chart.spec.x.column === column) {
      return chart.spec.x.label;
    }
    if (chart.spec.type === "funnel" && chart.spec.stage.column === column) {
      return chart.spec.stage.label;
    }
    if (chart.spec.type === "histogram") {
      return column === chart.spec.lowerBoundColumn ? `${chart.spec.xLabel}: lower bound` : `${chart.spec.xLabel}: upper bound`;
    }
    return column;
  }
  return (
    <details className={styles.data}>
      <summary>View data</summary>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${chart.spec.title} data`}>
        <table>
          <caption>Original values for {chart.spec.title}</caption>
          <thead><tr>{columns.map(column => <th key={column} scope="col">{columnLabel(column)}</th>)}</tr></thead>
          <tbody>
            {chart.rows.map((row, index) => (
              <tr key={index}>
                {columns.map(column => <td key={column}>{row[column] === null ? "Missing" : String(row[column])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function AnswerChart({ chart }: { chart: ChartDisplayResult }) {
  const titleId = useId();
  const captionId = useId();
  if (chart.kind === "unavailable") {
    return <section className={styles.chart}><h3>{chart.title}</h3><p role="status">{chart.message}</p></section>;
  }
  return (
    <figure className={styles.chart} aria-labelledby={titleId} aria-describedby={captionId}>
      <h3 id={titleId}>{chart.spec.title}</h3>
      <figcaption id={captionId}>{chart.spec.caption}</figcaption>
      <ChartViewport title={chart.spec.title}>
        <ChartRenderBoundary><ChartPlot chart={chart} /></ChartRenderBoundary>
      </ChartViewport>
      <ChartDataTable chart={chart} />
    </figure>
  );
}
