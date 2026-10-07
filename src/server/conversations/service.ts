import "server-only";
import type { AgentResult } from "../agent/runner-contracts";
import type { ToolDescription } from "../agent/contracts";
import { DEFAULT_AGENT_LIMITS } from "../agent/runner";
import type { AnalysisOutcome } from "../analysis/contracts";
import { ContextError, contextFailureCode, type BuildContextInput, type BuiltContext } from "../context/contracts";
import { ModelError } from "../agent/errors";
import {
  messageSubmissionSchema, retrySubmissionSchema,
  type MessageSubmission, type RetrySubmission, type ConversationSnapshot, type ChatStreamEvent,
} from "../../shared/conversations";
import type { AnalysisRunInput } from "../analysis/types";
import { reportSafely } from "../observability/reporting";
import { createAnalysisRecording } from "./analysis-recording";
import { ConversationRepositoryError, type ConversationRepository, type SubmissionLookup, type StartRunResult } from "./repository";
import type { ConversationRun, RunOutcome, RunVersions } from "./contracts";
import { projectConversation } from "./display";

export const RUN_DURATION_MS = 120_000;
export const FINALIZATION_GRACE_MS = 5_000;

export class ConversationServiceError extends Error {
  constructor(public readonly code: "unavailable" | "synchronization_failed", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationServiceError";
  }
}

export type PreparedConversationExecution = {
  versions: RunVersions;
  instructions: string[];
  tools: ToolDescription[];
  buildContext(input: BuildContextInput): BuiltContext;
  analyze(input: AnalysisRunInput): Promise<AgentResult<AnalysisOutcome>>;
};

type Dependencies = {
  repository: ConversationRepository;
  prepareExecution(): PreparedConversationExecution;
  now?: () => number;
  reportFailure?(diagnostic: { category: string; runId: string }): void;
};

export type AdmittedSubmission = {
  run: ConversationRun;
  created: boolean;
  snapshot: ConversationSnapshot;
  execute?: (signal: AbortSignal, emit: (event: ChatStreamEvent) => void) => Promise<void>;
};

function failedOutcome(error: unknown): Extract<RunOutcome, { kind: "failure" }> {
  let code: Extract<RunOutcome, { kind: "failure" }>["error"]["code"] = "internal";
  if (error instanceof ContextError) {
    code = contextFailureCode(error);
  } else if (error instanceof ConversationRepositoryError) {
    code = "persistence";
  }
  return {
    kind: "failure",
    status: "failed",
    error: { code, message: "The analysis could not be completed." },
  };
}

export function createConversationService(dependencies: Dependencies) {
  const { repository } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function reconcile(): Promise<void> {
    await repository.interruptExpiredRuns(now(), FINALIZATION_GRACE_MS);
  }

  async function load(conversationId: string): Promise<ConversationSnapshot> {
    await reconcile();
    return projectConversation(await repository.loadHistory(conversationId), dependencies.reportFailure);
  }

  async function resolveExecutionOutcome(
    run: ConversationRun,
    proposedOutcome: RunOutcome | null,
  ): Promise<ChatStreamEvent> {
    if (proposedOutcome) {
      try {
        await repository.finishRun(run.id, { outcome: proposedOutcome });
      } catch (error) {
        // Acceptance or expiry reconciliation may have won. Durable state resolves the race.
        if (!(error instanceof ConversationRepositoryError) || error.code !== "conflict") {
          throw error;
        }
      }
    }
    const snapshot = projectConversation(await repository.loadHistory(run.conversationId), dependencies.reportFailure);
    const attempt = snapshot.turns.flatMap(turn => turn.attempts).find(item => item.id === run.id);
    if (!attempt?.outcome) {
      throw new ConversationServiceError("synchronization_failed", "The analysis outcome could not be confirmed. Check status.");
    }
    const kind = attempt.outcome.kind === "failure" ? "error" : attempt.outcome.kind;
    return { kind, runId: run.id, snapshot };
  }

  async function execute(
    admittedRun: ConversationRun,
    prepared: PreparedConversationExecution,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const runId = admittedRun.id;
    let proposedOutcome: RunOutcome | null = null;
    try {
      const history = await repository.loadHistory(admittedRun.conversationId);
      const context = prepared.buildContext({
        history,
        targetRunId: runId,
        instructions: prepared.instructions,
        requestSettings: {
          tools: prepared.tools,
          toolSelection: { kind: "required" },
          maxOutputTokens: DEFAULT_AGENT_LIMITS.maxOutputTokens,
          deadline: admittedRun.deadline,
          signal,
        },
      });
      emit({ kind: "progress", runId, phase: "thinking" });
      const result = await prepared.analyze({
        conversationId: admittedRun.conversationId,
        context,
        storedEvidence: history.evidence,
        signal,
        deadline: admittedRun.deadline,
        ...createAnalysisRecording({ repository, runId, emit }),
      });
      if (result.kind === "failure") {
        proposedOutcome = {
          kind: "failure",
          status: result.error.code === "cancelled" ? "cancelled" : "failed",
          error: result.error,
        };
      }
    } catch (error) {
      proposedOutcome = failedOutcome(error);
      reportSafely(dependencies.reportFailure, { category: proposedOutcome.error.code, runId });
    }

    try {
      emit(await resolveExecutionOutcome(admittedRun, proposedOutcome));
    } catch {
      reportSafely(dependencies.reportFailure, { category: "synchronization_failed", runId });
      emit({
        kind: "error",
        runId,
        error: { code: "synchronization_failed", message: "The analysis outcome could not be confirmed. Check status." },
      });
    }
  }

  async function admit(conversationId: string, submission: MessageSubmission | RetrySubmission, retryRunId?: string): Promise<AdmittedSubmission> {
    await reconcile();
    let operation: SubmissionLookup["operation"];
    if ("message" in submission) {
      operation = { kind: "message", message: submission.message };
    } else {
      operation = { kind: "retry", runId: retryRunId ?? "" };
    }
    const duplicate = await repository.findSubmission({
      conversationId,
      clientMessageId: submission.clientMessageId,
      operation,
    });
    if (duplicate) {
      return { run: duplicate, created: false, snapshot: await load(conversationId) };
    }
    let prepared: PreparedConversationExecution;
    try {
      prepared = dependencies.prepareExecution();
    } catch (cause) {
      if (cause instanceof ModelError || cause instanceof ContextError || cause instanceof ConversationServiceError) {
        throw new ConversationServiceError("unavailable", "Analysis is not configured. Please try again later.", { cause });
      }
      throw cause;
    }
    const base = {
      conversationId,
      clientMessageId: submission.clientMessageId,
      expectedRevision: submission.expectedRevision,
      deadline: now() + RUN_DURATION_MS,
      versions: prepared.versions,
    };
    let result: StartRunResult;
    if ("message" in submission) {
      result = await repository.startRun({ ...base, message: submission.message });
    } else {
      result = await repository.retryRun({ ...base, runId: retryRunId ?? "" });
    }
    // Admission has committed. Snapshot failure must not leave an admitted run
    // with no owner; execute can still settle it using the recorded identity.
    let snapshot: ConversationSnapshot;
    try {
      snapshot = projectConversation(await repository.loadHistory(conversationId), dependencies.reportFailure);
    } catch (error) {
      if (result.created) {
        await repository.finishRun(result.run.id, { outcome: failedOutcome(error) });
      }
      throw error;
    }
    return {
      ...result,
      snapshot,
      execute: result.created ? (signal, emit) => execute(result.run, prepared, signal, emit) : undefined,
    };
  }

  return {
    async create(): Promise<ConversationSnapshot> {
      const conversation = await repository.createConversation();
      return projectConversation(await repository.loadHistory(conversation.id), dependencies.reportFailure);
    },
    load,
    submitMessage(conversationId: string, input: unknown) {
      return admit(conversationId, messageSubmissionSchema.parse(input));
    },
    retry(conversationId: string, runId: string, input: unknown) {
      return admit(conversationId, retrySubmissionSchema.parse(input), runId);
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
