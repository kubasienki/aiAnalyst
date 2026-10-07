"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Funnel, FunnelChart, LabelList, Legend,
  Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type { ChartSpec, ResolvedChart } from "../../shared/charts";
import { ChartTooltip } from "./ChartTooltip";
import { formatChartTick, formatChartValue } from "./format";
import { buildPlotRows, wrapCategoryLabel, type PlotRow } from "./plot-data";
import styles from "./charts.module.css";

const colors = ["#2563eb", "#b45309", "#15803d", "#9333ea", "#be123c"];
const margin = { top: 20, right: 24, bottom: 35, left: 24 };

type SeriesSpec = Extract<ChartSpec, { type: "line" | "bar" | "stacked_bar" }>;
type PlotProps<TSpec> = { spec: TSpec; rows: PlotRow[] };

function SeriesPlot({ spec, rows }: PlotProps<SeriesSpec>) {
  if (spec.type === "line") {
    return (
      <LineChart data={rows} margin={margin} accessibilityLayer>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" scale="time" dataKey="time" domain={["dataMin", "dataMax"]}
          tickFormatter={value => new Date(value).toISOString().slice(0, 10)}
          label={{ value: spec.x.label, position: "bottom" }} minTickGap={24} />
        <YAxis width={65} tickFormatter={value => formatChartTick(value, spec.series[0].format)} />
        <Tooltip content={<ChartTooltip spec={spec} />} filterNull={false} />
        <Legend verticalAlign="top" />
        {spec.series.map((field, index) => (
          <Line key={field.column} dataKey={(row: PlotRow) => row.values[index]} name={field.label}
            stroke={colors[index]} strokeWidth={2} strokeDasharray={index === 0 ? undefined : `${index * 3} 3`}
            connectNulls={false} dot={rows.length < 40} isAnimationActive={false} />
        ))}
      </LineChart>
    );
  }
  return (
    <BarChart data={rows} layout="vertical" margin={{ top: 20, right: 20, bottom: 15, left: 5 }} accessibilityLayer>
      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
      <XAxis
        type="number"
        domain={([minimum, maximum]: readonly [number, number]) => [Math.min(0, minimum), Math.max(0, maximum)]}
        tickFormatter={value => formatChartTick(value, spec.series[0].format)}
      />
      <YAxis type="category" dataKey="label" width={145} interval={0} tick={<CategoryTick />} />
      <Tooltip content={<ChartTooltip spec={spec} />} filterNull={false} />
      <Legend verticalAlign="top" />
      <ReferenceLine x={0} stroke="#64748b" />
      {spec.series.map((field, index) => (
        <Bar key={field.column} dataKey={(row: PlotRow) => row.values[index]} name={field.label}
          fill={colors[index]} stackId={spec.type === "stacked_bar" ? "composition" : undefined}
          isAnimationActive={false} />
      ))}
    </BarChart>
  );
}

function CategoryTick({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  const label = String(payload?.value ?? "");
  const lines = wrapCategoryLabel(label);
  return (
    <text x={x - 5} y={y - ((lines.length - 1) * 14) / 2} textAnchor="end" dominantBaseline="middle" fill="#334155" fontSize={12}>
      <title>{label}</title>
      {lines.map((line, index) => <tspan key={index} x={x - 5} dy={index === 0 ? 0 : 14}>{line}</tspan>)}
    </text>
  );
}

function ScatterPlot({ spec, rows }: PlotProps<Extract<ChartSpec, { type: "scatter" }>>) {
  return (
    <ScatterChart margin={margin} accessibilityLayer>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis type="number" dataKey={(row: PlotRow) => row.values[0]} name={spec.x.label}
          label={{ value: spec.x.label, position: "bottom" }} tickFormatter={value => formatChartTick(value, spec.x.format)} />
      <YAxis type="number" dataKey={(row: PlotRow) => row.values[1]} name={spec.y.label}
        width={80} tickFormatter={value => formatChartTick(value, spec.y.format)}
        label={{ value: spec.y.label, angle: -90, position: "insideLeft", style: { fontSize: 12 } }} />
      <Tooltip content={<ChartTooltip spec={spec} />} />
      <Scatter data={rows} fill={colors[0]} name={spec.y.label} isAnimationActive={false} />
    </ScatterChart>
  );
}

function HistogramPlot({ spec, rows }: PlotProps<Extract<ChartSpec, { type: "histogram" }>>) {
  return (
    <BarChart data={rows} margin={margin} barCategoryGap={0} accessibilityLayer>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" label={{ value: spec.xLabel, position: "bottom" }} minTickGap={24} />
      <YAxis width={80} allowDecimals={false}
        label={{ value: spec.count.label, angle: -90, position: "insideLeft", style: { fontSize: 12 } }} />
      <Tooltip content={<ChartTooltip spec={spec} />} />
      <Bar dataKey={(row: PlotRow) => row.values[0]} name={spec.count.label} fill={colors[0]}
        stroke="white" isAnimationActive={false} />
    </BarChart>
  );
}

function FunnelPlot({ spec, rows }: PlotProps<Extract<ChartSpec, { type: "funnel" }>>) {
  return (
    <FunnelChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }} accessibilityLayer>
      <Tooltip content={<ChartTooltip spec={spec} />} />
      <Funnel data={rows} dataKey={(row: PlotRow) => row.values[0]} nameKey="label" isAnimationActive={false}>
        {rows.map((row, index) => <Cell key={row.label} fill={colors[index % colors.length]} />)}
        <LabelList dataKey={(row: PlotRow) => formatChartValue(row.original[spec.count.column], spec.count.format)} position="center" fill="white" />
      </Funnel>
    </FunnelChart>
  );
}

export default function ChartPlot({ chart }: { chart: ResolvedChart }) {
  const rows = buildPlotRows(chart);
  const { spec } = chart;
  let plot;
  let height = 340;
  switch (spec.type) {
    case "line":
    case "bar":
    case "stacked_bar":
      plot = <SeriesPlot spec={spec} rows={rows} />;
      if (spec.type !== "line") {
        const labelHeight = Math.max(...rows.map(row => wrapCategoryLabel(row.label).length)) * 14 + 16;
        const barHeight = spec.type === "stacked_bar" ? 32 : spec.series.length * 14 + 16;
        height = Math.max(260, rows.length * Math.max(labelHeight, barHeight) + 80);
      }
      break;
    case "scatter":
      plot = <ScatterPlot spec={spec} rows={rows} />;
      break;
    case "histogram":
      plot = <HistogramPlot spec={spec} rows={rows} />;
      break;
    case "funnel":
      plot = <FunnelPlot spec={spec} rows={rows} />;
      break;
  }
  return (
    <>
      <div className={styles.plotCanvas}>
        <ResponsiveContainer width="100%" height={height} minWidth={0}>{plot}</ResponsiveContainer>
      </div>
      {spec.type === "funnel" && (
        <ol className={styles.funnelStages} aria-label="Funnel stages in order">
          {rows.map((row, index) => (
            <li key={row.label}>
              <span className={styles.stageMarker} style={{ backgroundColor: colors[index % colors.length] }} aria-hidden="true" />
              <span>{row.label}: <strong>{formatChartValue(row.original[spec.count.column], spec.count.format)}</strong></span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
