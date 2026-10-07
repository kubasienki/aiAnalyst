import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { assistantMessageSchema, modelMessageSchema, providerReplaySchema } from "./contracts";
import { ANALYSIS_TOOL_DESCRIPTIONS, analysisOutcomeSchema, answerSchema, runSqlArgumentsSchema } from "../analysis/contracts";

describe("agent contracts", () => {
  it("represents a question, tool call, result, and final action", () => {
    const messages = [
      { role: "user", content: "December revenue?" },
      { role: "assistant", content: null, toolCalls: [{ callId: "query", name: "run_sql", argumentsJson: '{"sql":"SELECT ..."}' }] },
      { role: "tool", callId: "query", content: { rows: [{ revenue_usd: 160555 }] } },
      { role: "assistant", content: null, toolCalls: [{ callId: "answer", name: "finish_answer", argumentsJson: "{}" }] },
    ];
    expect(messages.map(message => modelMessageSchema.parse(message))).toEqual(messages);
  });

  it("retains malformed argument JSON for later validation and feedback", () => {
    const message = { role: "assistant", content: null, toolCalls: [{ callId: "call", name: "run_sql", argumentsJson: "{bad json" }] };
    expect(assistantMessageSchema.parse(message).toolCalls[0].argumentsJson).toBe("{bad json");
    expect(runSqlArgumentsSchema.safeParse({ sql: "SELECT 1", bypass: true }).success).toBe(false);
    expect(runSqlArgumentsSchema.safeParse({ sql: " " }).success).toBe(false);
  });

  it("rejects empty assistant messages and duplicate call IDs", () => {
    expect(assistantMessageSchema.safeParse({ role: "assistant", content: null, toolCalls: [] }).success).toBe(false);
    const call = { callId: "same", name: "run_sql", argumentsJson: "{}" };
    expect(assistantMessageSchema.safeParse({ role: "assistant", content: null, toolCalls: [call, call] }).success).toBe(false);
  });

  it("distinguishes answers from clarification and excludes future chart fields", () => {
    expect(analysisOutcomeSchema.parse({ kind: "clarification", clarification: { question: "Which month?", choices: ["November", "December"] } }).kind).toBe("clarification");
    const answer = { narrative: "An explanation.", assumptions: [], limitations: [], evidenceIds: [], completeness: "complete" };
    expect(answerSchema.parse(answer)).toEqual(answer);
    expect(answerSchema.safeParse({ ...answer, chart: {} }).success).toBe(false);
    expect(answerSchema.safeParse({ ...answer, narrative: "x".repeat(16_001) }).success).toBe(false);
    const evidenceId = randomUUID();
    expect(answerSchema.safeParse({ ...answer, evidenceIds: [evidenceId, evidenceId] }).success).toBe(false);
  });

  it("exports tool JSON schemas from the runtime schemas", () => {
    expect(ANALYSIS_TOOL_DESCRIPTIONS.map(tool => tool.name)).toEqual(["run_sql", "request_clarification", "finish_answer"]);
    expect(ANALYSIS_TOOL_DESCRIPTIONS[0].parameters).toMatchObject({ type: "object", additionalProperties: false, required: ["intent", "sql"] });
  });

  it("preserves plaintext and structured reasoning without the former 16 KiB field cap", () => {
    const providerReplay = {
      origin: { model: "reasoning-model", provider: "provider-a", endpoint: "endpoint-a" },
      reasoning: `  ${"reasoning text\n".repeat(3_000)}  `,
      reasoningDetails: [
        { signature: "signed-text", type: "reasoning.text", text: "Original text.", index: 0 },
        { data: "encrypted-content", type: "reasoning.encrypted", id: "block-2", index: 1, extra: { values: [null, "unchanged"] } },
      ],
    };
    const message = {
      role: "assistant",
      content: null,
      toolCalls: [{ callId: "query", name: "run_sql", argumentsJson: "{}" }],
      providerReplay,
    };
    const parsed = assistantMessageSchema.parse(message);
    expect(parsed.providerReplay).toEqual(providerReplay);
    expect(JSON.stringify(parsed.providerReplay?.reasoningDetails)).toBe(JSON.stringify(providerReplay.reasoningDetails));
  });

  it("requires model origin and valid reasoning representations", () => {
    expect(providerReplaySchema.safeParse({ reasoning: "text" }).success).toBe(false);
    expect(providerReplaySchema.safeParse({ origin: { model: "model" } }).success).toBe(false);
    expect(providerReplaySchema.safeParse({ origin: { model: "model" }, reasoning: 123 }).success).toBe(false);
    expect(providerReplaySchema.safeParse({ origin: { model: "model" }, reasoningDetails: ["not a block"] }).success).toBe(false);
    expect(providerReplaySchema.parse({ origin: { model: "model" }, reasoning: "text" }).reasoning).toBe("text");
    expect(providerReplaySchema.parse({ origin: { model: "model" }, reasoningDetails: [] }).reasoningDetails).toEqual([]);
  });
});
