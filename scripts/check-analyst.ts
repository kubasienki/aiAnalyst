import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { openConversationRepository } from "../src/server/adapters/persistence/repository";
import { projectConversation } from "../src/server/conversations/display";
import { ANALYSIS_TOOL_DESCRIPTIONS } from "../src/server/analysis/contracts";
import { ANALYST_PROMPT_VERSION, ANALYSIS_TOOLS_VERSION, buildAnalystInstructions } from "../src/server/analysis/prompt";
import type { AnalysisCheckpoint } from "../src/server/analysis/types";
import { createAnalyst } from "../src/server/config/analysis";
import { createContext } from "../src/server/config/context";
import { readOpenRouterConfig } from "../src/server/config/openrouter";
import type { ConversationRepository } from "../src/server/conversations/repository";
import { SEMANTIC_GUIDE_VERSION } from "../src/server/data/semantic-guide";
import type { JsonValue } from "../src/server/contracts/json";
import { jsonValueSchema } from "../src/server/contracts/json";
import { ContextError } from "../src/server/context/contracts";
import { runSqlArgumentsSchema } from "../src/server/analysis/contracts";
import type { ConversationEvent } from "../src/server/conversations/contracts";
import { recoverableToolErrorSchema } from "../src/server/agent/contracts";
import { ModelError } from "../src/server/agent/errors";
import { analystEvaluationCases } from "./analyst-evaluation-cases";

class VerificationFailure extends Error {
  constructor(public readonly category: string) {
    super("Live analyst verification failed.");
  }
}

function recordedSqlAttempts(events: ConversationEvent[]): JsonValue[] {
  const attempts: JsonValue[] = [];
  for (const event of events) {
    if (event.payload.kind !== "assistant_message") {
      continue;
    }
    for (const call of event.payload.message.toolCalls) {
      if (call.name !== "run_sql") {
        continue;
      }
      try {
        const argumentsValue: unknown = JSON.parse(call.argumentsJson);
        const parsed = runSqlArgumentsSchema.safeParse(argumentsValue);
        if (parsed.success) {
          attempts.push({ intent: parsed.data.intent, sql: parsed.data.sql });
        }
      } catch {
        // A malformed call is not SQL. Never export raw provider replay data.
      }
    }
  }
  return attempts;
}

function recordedToolErrors(events: ConversationEvent[]): JsonValue[] {
  const errors: JsonValue[] = [];
  for (const event of events) {
    if (event.payload.kind !== "tool_result" || event.payload.result.payload.kind !== "inline") {
      continue;
    }
    const content = event.payload.result.payload.content;
    if (content === null || typeof content !== "object" || Array.isArray(content) || content.ok !== false) {
      continue;
    }
    const parsed = recoverableToolErrorSchema.safeParse(content.error);
    if (parsed.success) {
      errors.push(jsonValueSchema.parse(parsed.data));
    }
  }
  return errors;
}

async function saveCheckpoint(repository: ConversationRepository, runId: string, event: AnalysisCheckpoint) {
  switch (event.kind) {
    case "assistant":
      await repository.appendAssistant(runId, event.response.message);
      return;
    case "context_note":
      await repository.appendContextNote(runId, event.content);
      return;
    case "tool_result": {
      const artifact = event.artifact;
      if (!artifact) {
        await repository.recordToolResult(runId, { callId: event.callId, payload: { kind: "inline", content: event.content } });
        return;
      }
      const evidenceId = artifact.input.evidence.resultId;
      await repository.recordToolResult(runId, {
        callId: event.callId,
        payload: artifact.delivery === "visible"
          ? { kind: "evidence", evidenceId }
          : { kind: "evidence_unavailable", evidenceId, content: event.content },
      }, artifact.input);
      return;
    }
    case "terminal":
      await repository.finishRun(runId, {
        outcome: event.outcome,
        acknowledgment: { callId: event.callId, payload: { kind: "inline", content: event.acknowledgment } },
      });
  }
}

async function main() {
  const argumentsValue = process.argv.slice(2);
  const selectedCaseIds = argumentsValue.filter(argument => argument.startsWith("--case=")).map(argument => argument.slice("--case=".length));
  if (argumentsValue.some(argument => argument !== "--evaluate" && !argument.startsWith("--case="))
    || selectedCaseIds.some(id => !analystEvaluationCases.some(evaluationCase => evaluationCase.id === id))) {
    throw new Error("Usage: npm run analyst:check -- [--evaluate] [--case=<case-id> ...]");
  }
  loadEnvConfig(process.cwd(), true);
  const config = readOpenRouterConfig();
  const analyze = createAnalyst();
  const buildContext = createContext();
  const versions = { model: config.model, prompt: ANALYST_PROMPT_VERSION, tools: ANALYSIS_TOOLS_VERSION, semanticGuide: SEMANTIC_GUIDE_VERSION };
  const directory = mkdtempSync(join(tmpdir(), "hockeystack-analyst-"));
  const databasePath = join(directory, "history.sqlite");
  let repository = openConversationRepository({ databasePath });
  const report: JsonValue[] = [];
  try {
    let evaluationCases = analystEvaluationCases;
    if (selectedCaseIds.length > 0) {
      evaluationCases = analystEvaluationCases.filter(evaluationCase => selectedCaseIds.includes(evaluationCase.id));
    } else if (!argumentsValue.includes("--evaluate")) {
      const scalarCase = analystEvaluationCases.find(evaluationCase => evaluationCase.id === "scalar-and-comparison");
      if (!scalarCase) {
        throw new VerificationFailure("missing_scalar_case");
      }
      evaluationCases = [{ ...scalarCase, questions: [scalarCase.questions[0]] }];
    }
    for (const evaluationCase of evaluationCases) {
      const conversation = await repository.createConversation();
      for (const question of evaluationCase.questions) {
        const signal = new AbortController().signal;
        const deadline = Date.now() + 120_000;
        const previousHistory = await repository.loadHistory(conversation.id);
        const expectedRevision = projectConversation(previousHistory).revision;
        const { run } = await repository.startRun({ conversationId: conversation.id, message: question, clientMessageId: randomUUID(), deadline, versions, expectedRevision });
        const history = await repository.loadHistory(conversation.id);
        const context = buildContext({ history, targetRunId: run.id, instructions: buildAnalystInstructions(), requestSettings: {
          tools: ANALYSIS_TOOL_DESCRIPTIONS, toolSelection: { kind: "required" }, maxOutputTokens: 4096, signal, deadline,
        } });
        const result = await analyze({ conversationId: conversation.id, context, storedEvidence: history.evidence, signal, deadline,
          checkpoint: event => saveCheckpoint(repository, run.id, event) });
        if (result.kind === "failure") {
          await repository.finishRun(run.id, { outcome: { kind: "failure", status: result.error.code === "cancelled" ? "cancelled" : "failed", error: result.error } });
          const failedHistory = await repository.loadHistory(conversation.id);
          report.push({ caseId: evaluationCase.id, reviewCriteria: evaluationCase.reviewCriteria,
            reviewStatus: "execution_failed", question, versions, statistics: result.statistics,
            error: result.error, contextMeasurement: jsonValueSchema.parse(context.measurement),
            sqlAttempts: recordedSqlAttempts(failedHistory.events.filter(event => event.runId === run.id)),
            toolErrors: recordedToolErrors(failedHistory.events.filter(event => event.runId === run.id)) });
          mkdirSync(".data", { recursive: true });
          writeFileSync(".data/analyst-check-report.json", JSON.stringify(report, null, 2));
          throw new VerificationFailure(result.error.code);
        }
        if (result.outcome.kind !== "answer") {
          report.push({ caseId: evaluationCase.id, reviewCriteria: evaluationCase.reviewCriteria,
            reviewStatus: "failed", question, outcome: jsonValueSchema.parse(JSON.parse(JSON.stringify(result.outcome))), statistics: result.statistics });
          mkdirSync(".data", { recursive: true });
          writeFileSync(".data/analyst-check-report.json", JSON.stringify(report, null, 2));
          throw new VerificationFailure("unexpected_clarification");
        }
        assert.ok(result.outcome.answer.evidenceIds.length > 0, "Data answers need real evidence");
        const before = await repository.loadHistory(conversation.id);
        repository.close();
        repository = openConversationRepository({ databasePath });
        const reopened = await repository.loadHistory(conversation.id);
        assert.deepEqual(reopened, before, "Reopened SQLite exchange must remain intact");
        const supportingEvidence = reopened.evidence.filter(item => result.outcome.kind === "answer" && result.outcome.answer.evidenceIds.includes(item.evidence.resultId));
        assert.equal(supportingEvidence.length, result.outcome.answer.evidenceIds.length);
        const displayAttempt = projectConversation(reopened).turns
          .flatMap(turn => turn.attempts)
          .find(attempt => attempt.id === run.id);
        assert.ok(displayAttempt, "Accepted answer must be present in the display snapshot");
        const chartDisplay = (displayAttempt.renderedCharts ?? []).map(chart => ({
          title: chart.kind === "ready" ? chart.spec.title : chart.title,
          status: chart.kind,
        }));
        assert.ok(chartDisplay.every(chart => chart.status === "ready"), "Accepted charts must resolve for display");
        report.push({ caseId: evaluationCase.id, reviewCriteria: evaluationCase.reviewCriteria,
          reviewStatus: "pending", question, chartDisplay, outcome: jsonValueSchema.parse(JSON.parse(JSON.stringify(result.outcome))), statistics: result.statistics,
          versions,
          contextMeasurement: jsonValueSchema.parse(context.measurement),
          toolErrors: recordedToolErrors(reopened.events.filter(event => event.runId === run.id)),
          evidence: supportingEvidence.map(item => ({ resultId: item.evidence.resultId, intent: item.declaredScope?.intent ?? null,
            sql: item.evidence.sql, rows: item.evidence.rows, truncated: item.evidence.truncated, jobId: item.evidence.jobId })) });
        mkdirSync(".data", { recursive: true });
        writeFileSync(".data/analyst-check-report.json", JSON.stringify(report, null, 2));
        console.log(`Accepted and reopened: ${question}`, { modelRequests: result.statistics.modelRequests,
          evidenceCount: supportingEvidence.length, chartCount: chartDisplay.length, completeness: result.outcome.answer.completeness });
      }
    }
    console.log("Analyst protocol/provenance verification passed. Analytical review is pending: assess each report entry against its reviewCriteria using the narratives, SQL and rows in .data/analyst-check-report.json. Use bigquery:verify for independent reference values.");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  // Avoid SDK/provider exceptions, prompts, arguments, reasoning or credentials.
  const category = error instanceof VerificationFailure ? error.category
    : error instanceof ContextError || error instanceof ModelError ? error.code : "verification";
  console.error(`Analyst live verification failed (${category}). Inspect the accepted-result report and run the separate connection checks.`);
  process.exitCode = 1;
});
