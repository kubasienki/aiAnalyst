import type { AnalysisMetadata } from "../../shared/analysis-metadata";

// Shared input for workflow tests; analytical correctness has independent cases.
export function analysisMetadataFixture(evidenceIds: string[] = []): AnalysisMetadata {
  return {
    version: 1,
    context: {
      question: "How much recorded purchase revenue did December produce?",
      intent: "analysis",
      period: { start: "2020-12-01", end: "2020-12-31" },
      comparisonPeriod: null,
      filters: [],
      population: "Recorded purchase events",
      followupMode: "new",
    },
    findings: evidenceIds.length > 0 ? [{
      statement: "Recorded revenue is available for December.",
      evidenceIds,
      interpretation: "This measures recorded sales, not profit.",
    }] : [],
    openQuestions: [],
  };
}
