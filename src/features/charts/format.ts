import type { ChartCell, ValueFormat } from "../../shared/charts";

function isNumericLiteral(value: string): value is Intl.StringNumericLiteral {
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
}

export function formatChartValue(value: ChartCell, format: ValueFormat): string {
  if (value === null) {
    return "Missing";
  }
  if (typeof value === "string" && !isNumericLiteral(value)) {
    return value;
  }
  const options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 };
  if (format.kind === "currency") {
    options.style = "currency";
    options.currency = format.currency;
  } else if (format.kind === "percentage" && format.inputScale === "ratio") {
    options.style = "percent";
  }
  // Modern Intl accepts exact decimal strings, avoiding Number coercion before
  // rounding a monetary label (for example, 1.005 must display as $1.01).
  const formatted = new Intl.NumberFormat("en-US", options).format(value);
  if (format.kind === "percentage" && format.inputScale === "percent") {
    return `${formatted}%`;
  }
  return formatted;
}

export function valueUnitLabel(format: ValueFormat): string {
  switch (format.kind) {
    case "number":
      return "";
    case "currency":
      return format.currency;
    case "percentage":
      return format.inputScale === "ratio" ? "ratio, displayed as %" : "%";
  }
}

export function formatChartTick(value: number, format: ValueFormat): string {
  if (format.kind === "percentage") {
    return formatChartValue(value, format);
  }
  const options: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  };
  if (format.kind === "currency") {
    options.style = "currency";
    options.currency = format.currency;
  }
  return new Intl.NumberFormat("en-US", options).format(value);
}
