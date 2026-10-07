import "server-only";
import type { AnalysisRunInput } from "../analysis/types";
import { AgentRunnerError } from "../agent/runner-contracts";
import { jsonValueSchema } from "../contracts/json";
import type { ChatStreamEvent } from "../../shared/conversations";
import { ConversationRepositoryError, type ConversationRepository } from "./repository";
import type { StoredToolResult } from "./contracts";

type RecordingDependencies = {
  repository: ConversationRepository;
  runId: string;
  emit(event: ChatStreamEvent): void;
};

type AnalysisRecording = Pick<AnalysisRunInput, "checkpoint" | "recordModelCall" | "recordToolCall">;

export function createAnalysisRecording({ repository, runId, emit }: RecordingDependencies): AnalysisRecording {
  return {
    async recordModelCall(trace, signal) {
      if (signal.aborted) {
        return;
      }
      await repository.recordAgentTrace(runId, {
        kind: "model_call",
        payload: jsonValueSchema.parse(JSON.parse(JSON.stringify(trace))),
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
      });
    },
    async recordToolCall(trace, signal) {
      if (signal.aborted) {
        return;
      }
      await repository.recordAgentTrace(runId, {
        kind: "tool_call",
        payload: jsonValueSchema.parse(JSON.parse(JSON.stringify(trace))),
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
      });
    },
    async checkpoint(event) {
      try {
        switch (event.kind) {
          case "assistant":
            await repository.appendAssistant(runId, event.response.message);
            if (event.response.message.toolCalls.some(call => call.name === "run_sql")) {
              emit({ kind: "progress", runId, phase: "querying" });
            }
            return;
          case "context_note":
            await repository.appendContextNote(runId, event.content);
            return;
          case "tool_result": {
            const artifact = event.artifact;
            if (!artifact) {
              await repository.recordToolResult(runId, {
                callId: event.callId,
                payload: { kind: "inline", content: event.content },
              });
            } else {
              const evidenceId = artifact.input.evidence.resultId;
              let payload: StoredToolResult["payload"];
              if (artifact.delivery === "visible") {
                payload = { kind: "evidence", evidenceId };
              } else {
                payload = {
                  kind: "evidence_unavailable",
                  evidenceId,
                  content: event.content,
                };
              }
              await repository.recordToolResult(runId, {
                callId: event.callId,
                payload,
              }, artifact.input);
            }
            emit({ kind: "progress", runId, phase: "thinking" });
            return;
          }
          case "terminal":
            await repository.finishRun(runId, {
              outcome: event.outcome,
              acknowledgment: {
                callId: event.callId,
                payload: { kind: "inline", content: event.acknowledgment },
              },
            });
        }
      } catch (cause) {
        throw new AgentRunnerError("persistence", "The execution checkpoint could not be saved.", {
          cause,
          origin: {
            boundary: "checkpoint",
            category: cause instanceof ConversationRepositoryError ? cause.code : "write_failed",
          },
        });
      }
    },
  };
}
