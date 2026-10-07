import { chartValueFields, type ChartSpec } from "../../shared/charts";
import { formatChartValue } from "./format";
import { plotRowSchema } from "./plot-data";
import styles from "./charts.module.css";

type Props = {
  spec: ChartSpec;
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
};

export function ChartTooltip({ spec, active, payload }: Props) {
  if (!active || !payload?.length) {
    return null;
  }
  const parsed = plotRowSchema.safeParse(payload[0].payload);
  if (!parsed.success) {
    return null;
  }
  const row = parsed.data;
  return (
    <div className={styles.tooltip}>
      <strong>{row.label}</strong>
      {chartValueFields(spec).map(field => {
        const original = row.original[field.column];
        return (
          <p key={field.column}>
            {field.label}: {formatChartValue(original, field.format)}
            {typeof original === "string" && <span className={styles.exactValue}>Original: {original}</span>}
          </p>
        );
      })}
    </div>
  );
}
