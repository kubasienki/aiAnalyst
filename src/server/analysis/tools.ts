import "server-only";
import { errorContent } from "../agent/actions";
import type { RecoverableToolError, RegisteredTool, ToolExecution } from "../agent/contracts";
import { AgentRunnerError } from "../agent/runner-contracts";
import { registerTool } from "../agent/tool-registration";
import { ContextError } from "../context/contracts";
import { prepareAnswerCharts } from "../charts/prepare";
import { projectEvidence } from "../context/evidence";
import { jsonValueSchema } from "../contracts/json";
import { evidenceInputSchema } from "../conversations/contracts";
import { SEMANTIC_GUIDE_VERSION, semanticSnapshotForQuery } from "../data/semantic-guide";
import { describeDatasetTopic } from "../data/dataset-catalog";
import type { QueryErrorCode, QueryExecutor } from "../data/types";
import {
  ANALYSIS_TOOL_DESCRIPTIONS, answerSchema, clarificationSchema,
  finishAnswerArgumentsSchema, inspectDatasetArgumentsSchema, runSqlArgumentsSchema, type AnalysisOutcome,
} from "./contracts";
import type { AnalysisEvidenceArtifact, AnalysisRunState } from "./types";
import { validateAnalyticalAnswer } from "./answer-validation";

type AnalysisTool = RegisteredTool<AnalysisRunState, AnalysisOutcome, AnalysisEvidenceArtifact>;
type AnalysisExecution = ToolExecution<AnalysisOutcome, AnalysisEvidenceArtifact>;
const deterministicQueryErrors = new Set<QueryErrorCode>([
  "invalid_input", "invalid_query", "rejected_sql", "unsupported_sql", "processing_limit", "result_size",
]);

export function createAnalysisTools(executeQuery: QueryExecutor): AnalysisTool[] {
  function description(name: string) {
    const result = ANALYSIS_TOOL_DESCRIPTIONS.find(candidate => candidate.name === name);
    if (!result) {
      throw new Error(`Missing descriptor for ${name}.`);
    }
    return result;
  }
  return [
    registerTool({
      ...description("inspect_dataset"),
      role: "continuing",
      argumentsSchema: inspectDatasetArgumentsSchema,
      async handle({ topic }): Promise<AnalysisExecution> {
        return { kind: "continue", content: jsonValueSchema.parse(describeDatasetTopic(topic)) };
      },
    }),
    registerTool({
      ...description("run_sql"),
      role: "continuing",
      argumentsSchema: runSqlArgumentsSchema,
      isAvailable(state: AnalysisRunState) {
        const budget = state.queryExecution.budget;
        return budget.attemptsUsed < budget.maxAttempts && budget.resultBytesUsed < budget.maxResultBytes;
      },
      async handle(argumentsValue, invocation): Promise<AnalysisExecution> {
        const state = invocation.applicationContext;
        const result = await executeQuery({ sql: argumentsValue.sql }, {
          ...state.queryExecution,
          signal: invocation.signal,
          deadline: invocation.deadline,
        });
        if (!result.ok) {
          if (result.error.code === "cancelled" || result.error.code === "deadline") {
            throw new AgentRunnerError(result.error.code, result.error.message);
          }
          return {
            kind: "error",
            error: { code: result.error.code, message: result.error.message },
            repeatPolicy: deterministicQueryErrors.has(result.error.code) ? "unchanged_arguments" : "until_progress",
          };
        }
        if (result.evidence.semanticGuideVersion !== SEMANTIC_GUIDE_VERSION) {
          throw new AgentRunnerError("internal", "The query and analyst semantic versions disagree.");
        }
        const input = evidenceInputSchema.parse({
          evidence: result.evidence,
          semanticGuideSnapshot: semanticSnapshotForQuery(result.evidence.sql),
          declaredScope: { intent: argumentsValue.intent },
          assumptions: [],
        });
        const artifact: AnalysisEvidenceArtifact = { kind: "query_evidence", input, delivery: "visible" };
        const content = projectEvidence(input);
        try {
          invocation.checkContinuation(content);
        } catch (error) {
          if (!(error instanceof ContextError) || error.code !== "context_limit") {
            throw error;
          }
          const feedback: RecoverableToolError = {
            code: "result_too_large_for_context",
            message: "The complete result cannot fit model context. Its rows were not supplied. Request fewer columns or stronger aggregation if the remaining budget permits.",
            details: {
              evidenceId: input.evidence.resultId,
              intent: argumentsValue.intent,
              payloadBytes: input.evidence.payloadBytes,
              rowCount: input.evidence.rows.length,
              truncated: input.evidence.truncated,
              ...(input.evidence.truncationReason ? { truncationReason: input.evidence.truncationReason } : {}),
            },
          };
          // Preflight feedback too. Even compact feedback may exceed remaining
          // context; that is a stopping error, not permission to drop history.
          invocation.checkContinuation(errorContent(feedback));
          return {
            kind: "error",
            error: feedback,
            repeatPolicy: "unchanged_arguments",
            artifact: { ...artifact, delivery: "unavailable" },
          };
        }
        return { kind: "continue", content, artifact };
      },
    }),
    registerTool({
      ...description("request_clarification"),
      role: "terminal",
      argumentsSchema: clarificationSchema,
      async handle(clarification): Promise<AnalysisExecution> {
        return {
          kind: "terminal",
          acknowledgment: { accepted: true, kind: "clarification" },
          outcome: { kind: "clarification", clarification },
        };
      },
    }),
    registerTool({
      ...description("finish_answer"),
      role: "terminal",
      argumentsSchema: finishAnswerArgumentsSchema,
      async handle(argumentsValue, invocation): Promise<AnalysisExecution> {
        const { basis, ...answerFields } = argumentsValue;
        const answer = answerSchema.parse(answerFields);
        const evidence = invocation.applicationContext.visibleEvidence;
        if (basis === "data" && answer.evidenceIds.length === 0) {
          return { kind: "error", error: { code: "missing_evidence", message: "Dataset findings require evidence actually supplied in this context. Query the data before answering." } };
        }
        if (answer.evidenceIds.some(id => !evidence.has(id))) {
          return { kind: "error", error: { code: "invalid_evidence", message: "Reference only evidence belonging to this conversation and supplied with rows in the current context." } };
        }
        const analyticalError = validateAnalyticalAnswer(argumentsValue, invocation);
        if (analyticalError) {
          return { kind: "error", error: analyticalError, repeatPolicy: "until_progress" };
        }
        const referencesTruncation = answer.evidenceIds.some(id => evidence.get(id)?.evidence.truncated);
        if (referencesTruncation && (answer.completeness !== "partial" || answer.limitations.length === 0)) {
          return { kind: "error", error: { code: "incomplete_evidence", message: "Referenced service-truncated results require partial completeness and an explicit truncation limitation." } };
        }
        const chartResult = prepareAnswerCharts(
          answer.charts ?? [],
          answer.evidenceIds,
          id => evidence.get(id)?.evidence,
        );
        if (!chartResult.ok) {
          return {
            kind: "error",
            error: {
              code: chartResult.error.code,
              message: `${chartResult.error.message} Repair the identified chart or use a simpler supported visualization. Preserve other valid charts; remove only visuals that cannot be supported within the remaining budget.`,
              details: { chartIndex: chartResult.error.chartIndex },
            },
            repeatPolicy: "unchanged_arguments",
          };
        }
        return {
          kind: "terminal",
          acknowledgment: { accepted: true, kind: "answer" },
          outcome: { kind: "answer", answer },
        };
      },
    }),
  ];
}
