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
import { ModelError } from "../src/server/agent/errors";

class VerificationFailure extends Error {
  constructor(public readonly category: string) {
    super("Live analyst verification failed.");
  }
}

const evaluationConversations = [
  ["How much revenue did we make in December 2020?", "How did it compare with November?", "Which devices contributed most to that change?"],
  ["What was session purchase conversion in December 2020?", "What about mobile only?", "What about the previous month?"],
  ["What were the top five products by recorded item revenue in January 2021?"],
  ["Where did sessions stop progressing through the ordered checkout funnel in December 2020?"],
  ["Why did recorded revenue drop in January compared with December? Investigate observable contributors."],
  ["Why did revenue decline from November to December 2020?"],
];

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
  if (argumentsValue.some(argument => argument !== "--evaluate")) {
    throw new Error("Usage: npm run analyst:check -- [--evaluate]");
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
    const conversations = argumentsValue.includes("--evaluate") ? evaluationConversations : [[evaluationConversations[0][0]]];
    for (const questions of conversations) {
      const conversation = await repository.createConversation();
      for (const question of questions) {
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
          throw new VerificationFailure(result.error.code);
        }
        assert.equal(result.outcome.kind, "answer", "Golden questions must produce accepted answers");
        if (result.outcome.kind !== "answer") throw new Error("Expected answer");
        assert.ok(result.outcome.answer.evidenceIds.length > 0, "Data answers need real evidence");
        const before = await repository.loadHistory(conversation.id);
        repository.close();
        repository = openConversationRepository({ databasePath });
        const reopened = await repository.loadHistory(conversation.id);
        assert.deepEqual(reopened, before, "Reopened SQLite exchange must remain intact");
        const supportingEvidence = reopened.evidence.filter(item => result.outcome.kind === "answer" && result.outcome.answer.evidenceIds.includes(item.evidence.resultId));
        assert.equal(supportingEvidence.length, result.outcome.answer.evidenceIds.length);
        report.push({ question, outcome: jsonValueSchema.parse(JSON.parse(JSON.stringify(result.outcome))), statistics: result.statistics,
          evidence: supportingEvidence.map(item => ({ resultId: item.evidence.resultId, intent: item.declaredScope?.intent ?? null,
            sql: item.evidence.sql, rows: item.evidence.rows, truncated: item.evidence.truncated, jobId: item.evidence.jobId })) });
        mkdirSync(".data", { recursive: true });
        writeFileSync(".data/analyst-check-report.json", JSON.stringify(report, null, 2));
        console.log(`Accepted and reopened: ${question}`, { modelRequests: result.statistics.modelRequests,
          evidenceCount: supportingEvidence.length, completeness: result.outcome.answer.completeness });
      }
    }
    console.log("Analyst live verification passed. Review narratives and SQL in .data/analyst-check-report.json against bigquery:verify; accepted protocol/provenance alone does not prove analytical correctness.");
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
