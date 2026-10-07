import { z } from "zod";
import { chartCellSchema, chartValueFields, type ResolvedChart } from "../../shared/charts";

export const plotRowSchema = z.object({
  label: z.string(),
  values: z.array(z.number().finite().nullable()),
  original: z.record(z.string(), chartCellSchema),
  time: z.number().finite().optional(),
});

export type PlotRow = z.infer<typeof plotRowSchema>;

export function wrapCategoryLabel(label: string, maxCharacters = 18): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/)) {
    if (line && line.length + word.length + 1 > maxCharacters) {
      lines.push(line);
      line = "";
    }
    const characters = [...word];
    while (characters.length > maxCharacters) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(characters.splice(0, maxCharacters).join(""));
    }
    line = line ? `${line} ${characters.join("")}` : characters.join("");
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

export function buildPlotRows(chart: ResolvedChart): PlotRow[] {
  const { spec } = chart;
  const fields = chartValueFields(spec);
  return chart.rows.map(original => {
    let label: string;
    switch (spec.type) {
      case "line":
      case "bar":
      case "stacked_bar":
        label = String(original[spec.x.column]);
        break;
      case "scatter":
        label = spec.pointLabelColumn ? String(original[spec.pointLabelColumn] ?? "") : "Point";
        break;
      case "histogram":
        label = `${original[spec.lowerBoundColumn]} – ${original[spec.upperBoundColumn]}`;
        break;
      case "funnel":
        label = String(original[spec.stage.column]);
        break;
    }
    return {
      label,
      values: fields.map(field => original[field.column] === null ? null : Number(original[field.column])),
      original,
      ...(spec.type === "line" ? { time: Date.parse(String(original[spec.x.column])) } : {}),
    };
  });
}
