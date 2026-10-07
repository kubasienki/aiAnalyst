import "server-only";
import type { Answer } from "../../shared/analysis";
import type { ChartDisplayResult } from "../../shared/charts";
import { prepareAnswerCharts, type ChartEvidenceLookup } from "./prepare";
import { reportSafely } from "../observability/reporting";

export function projectAnswerCharts(
  answer: Answer,
  lookupEvidence: ChartEvidenceLookup,
  reportFailure: (category: string) => void,
): ChartDisplayResult[] {
  const specs = answer.charts ?? [];
  try {
    const result = prepareAnswerCharts(specs, answer.evidenceIds, lookupEvidence);
    if (result.ok) {
      return result.charts;
    }
    reportSafely(reportFailure, result.error.code);
  } catch {
    // A display failure must not undo an already committed analytical answer.
    reportSafely(reportFailure, "chart_projection");
  }
  return specs.map(spec => ({
    kind: "unavailable",
    title: spec.title,
    message: "This chart is unavailable. The saved answer is still shown.",
  }));
}
