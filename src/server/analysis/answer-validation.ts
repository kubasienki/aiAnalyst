import "server-only";
import type { RecoverableToolError, ToolInvocationContext } from "../agent/contracts";
import type { z } from "zod";
import type { finishAnswerArgumentsSchema } from "./contracts";
import type { AnalysisRunState } from "./types";

export function validateAnalyticalAnswer(
  answer: z.infer<typeof finishAnswerArgumentsSchema>,
  invocation: ToolInvocationContext<AnalysisRunState>,
): RecoverableToolError | undefined {
  const { analysis, evidenceIds, basis } = answer;
  if (basis === "data" && analysis.findings.length === 0) {
    return { code: "missing_findings", message: "Data answers require at least one evidence-backed finding." };
  }
  for (const finding of analysis.findings) {
    if (new Set(finding.evidenceIds).size !== finding.evidenceIds.length
      || finding.evidenceIds.some(id => !evidenceIds.includes(id)
        || !invocation.applicationContext.visibleEvidence.has(id))) {
      return { code: "invalid_evidence", message: "Each finding must reference unique, visible evidence included in the answer." };
    }
  }
  const necessaryQuestions = analysis.openQuestions.filter(question => question.requiredForAnswer);
  if (necessaryQuestions.some(question => !question.canInvestigate && question.obstacle === null)) {
    return { code: "missing_obstacle", message: "Explain which missing data prevents investigating the necessary question." };
  }
  if (necessaryQuestions.length > 0 && answer.completeness === "complete") {
    return { code: "incomplete_investigation", message: "A necessary question remains unresolved. Investigate it or mark the supported answer partial with the specific gap." };
  }
  const budget = invocation.applicationContext.queryExecution.budget;
  const sqlAvailable = budget.attemptsUsed < budget.maxAttempts
    && budget.resultBytesUsed < budget.maxResultBytes
    && Date.now() < invocation.deadline;
  if (analysis.context.intent === "diagnosis" && invocation.canContinue && sqlAvailable
    && necessaryQuestions.some(question => question.canInvestigate && question.obstacle === null)) {
    return { code: "investigation_required", message: "A necessary diagnostic question can still be investigated. Run a relevant test rather than finish early. If a specific data obstacle prevents progress, describe it and disclose the limitation in a partial answer." };
  }
  if (necessaryQuestions.length > 0 && answer.limitations.length === 0) {
    return { code: "missing_limitation", message: "Explain the specific unanswered question and obstacle or execution limit in limitations." };
  }
}
