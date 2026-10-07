import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { conversationRevision, revisionSchema } from "../../../shared/conversations";
import { assistantMessageSchema, type ToolCall } from "../../agent/contracts";
import { inspectMessageSequence, type MessageSequenceEntry } from "../../agent/message-sequence";
import { transcriptSequence } from "../../conversations/transcript";
import { jsonValueSchema } from "../../contracts/json";
import { canonicalJson } from "../../contracts/json-equality";
import { assertRunAdmission, assertRetryEligibility, checkRunFinalization, ConversationPolicyViolation } from "../../conversations/policies";
import {
  conversationEventSchema, conversationSchema, evidenceInputSchema, eventPayloadSchema,
  identitySchema, outcomeStatus, runOutcomeSchema, runSchema, runVersionsSchema,
  storedEvidenceSchema, storedToolResultSchema,
  type ConversationEvent, type ConversationRun, type EventPayload, type EvidenceInput,
  type StoredToolResult,
} from "../../conversations/contracts";
import {
  ConversationRepositoryError, type ConversationRepository,
  type AgentTraceInput, type FinishRunInput, type StartRunResult,
} from "../../conversations/repository";
import { agentTraces, conversations, events, INITIALIZE_SCHEMA, queryEvidence, runs } from "./schema";

const startRunSchema = z.strictObject({
  conversationId: identitySchema,
  clientMessageId: identitySchema,
  message: z.string().trim().min(1).max(2_000),
  deadline: z.number().int().nonnegative().safe(),
  versions: runVersionsSchema,
  expectedRevision: revisionSchema,
});

const retryRunSchema = startRunSchema.omit({ message: true }).extend({ runId: identitySchema });
const finishRunSchema = z.strictObject({
  outcome: runOutcomeSchema,
  acknowledgment: storedToolResultSchema.optional(),
});

type Options = { databasePath: string; now?: () => number };

function conflict(message: string, conflictReason?: ConversationRepositoryError["conflictReason"]): never {
  throw new ConversationRepositoryError("conflict", message, { conflictReason });
}

function decode<T>(schema: z.ZodType<T>, encoded: string): T {
  try {
    const value: unknown = JSON.parse(encoded);
    return schema.parse(value);
  } catch (cause) {
    throw new ConversationRepositoryError("invalid_record", "Stored conversation data is invalid.", { cause });
  }
}

function readRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new ConversationRepositoryError("invalid_record", "Stored conversation data is invalid.", { cause });
  }
}

export function openConversationRepository(options: Options): ConversationRepository {
  let connection: Database.Database;
  try {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    connection = new Database(options.databasePath);
  } catch (cause) {
    throw new ConversationRepositoryError("unavailable", "The conversation database could not be opened.", { cause });
  }

  const db = drizzle(connection);
  const now = options.now ?? Date.now;
  let closed = false;

  try {
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");
    // better-sqlite3 waits synchronously under contention; this bounds lock
    // waiting, not total operation duration, and can block the Node event loop.
    connection.pragma("busy_timeout = 5000");
    connection.transaction(() => connection.exec(INITIALIZE_SCHEMA)).immediate();
    // Selecting every declared column also catches incompatible older table shapes.
    db.select().from(conversations).limit(0).all();
    db.select().from(runs).limit(0).all();
    db.select().from(events).limit(0).all();
    db.select().from(queryEvidence).limit(0).all();
    db.select().from(agentTraces).limit(0).all();
  } catch (cause) {
    connection.close();
    throw new ConversationRepositoryError(
      "unavailable",
      "The conversation schema could not be initialized. An incompatible assessment database may need a manual reset.",
      { cause },
    );
  }

  async function perform<T>(operation: () => T): Promise<T> {
    if (closed) {
      throw new ConversationRepositoryError("unavailable", "The conversation database is closed.");
    }
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof ConversationPolicyViolation) {
        throw new ConversationRepositoryError("conflict", cause.message, {
          cause,
          conflictReason: cause.reason,
        });
      }
      if (cause instanceof ConversationRepositoryError) {
        throw cause;
      }
      if (cause instanceof z.ZodError) {
        throw new ConversationRepositoryError("invalid_input", "Invalid conversation repository input.", { cause });
      }
      throw new ConversationRepositoryError("unavailable", "The conversation database operation failed.", { cause });
    }
  }

  function transaction<T>(operation: () => T): T {
    // Reserve the write lock before reads; another connection cannot race a sequence or active-run check.
    return connection.transaction(operation).immediate();
  }

  function getConversation(conversationId: string) {
    const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!row) {
      throw new ConversationRepositoryError("not_found", "Conversation not found.");
    }
    return readRecord(conversationSchema, row);
  }

  function readRun(row: typeof runs.$inferSelect): ConversationRun {
    const { requestJson, versionsJson, outcomeJson, ...record } = row;
    // Validate internal request provenance too, even though it is not part of the public run contract.
    decode(jsonValueSchema, requestJson);
    return readRecord(runSchema, {
      ...record,
      versions: decode(runVersionsSchema, versionsJson),
      outcome: outcomeJson === null ? null : decode(runOutcomeSchema, outcomeJson),
    });
  }

  function getRun(runId: string): ConversationRun {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) {
      throw new ConversationRepositoryError("not_found", "Run not found.");
    }
    return readRun(row);
  }

  function requireActiveRun(runId: string): ConversationRun {
    const run = getRun(runId);
    if (run.status !== "running") {
      conflict("The run has already ended.");
    }
    return run;
  }

  function readEvent(row: typeof events.$inferSelect): ConversationEvent {
    const { payloadJson, ...record } = row;
    return readRecord(conversationEventSchema, { ...record, payload: decode(eventPayloadSchema, payloadJson) });
  }

  function runEvents(runId: string): ConversationEvent[] {
    return db.select().from(events)
      .where(eq(events.runId, runId))
      .orderBy(asc(events.sequence))
      .all().map(readEvent);
  }

  function validateAppend(runId: string, next: MessageSequenceEntry): void {
    const sequence = inspectMessageSequence([...transcriptSequence(runEvents(runId)), next]);
    if (!sequence.valid) {
      conflict("The event does not follow the pending tool-call sequence.");
    }
  }

  function appendEvent(run: ConversationRun, payload: EventPayload, timestamp: number): ConversationEvent {
    const latest = db.select({ sequence: sql<number>`coalesce(max(${events.sequence}), 0)` })
      .from(events).where(eq(events.conversationId, run.conversationId)).get();
    const event = conversationEventSchema.parse({
      id: randomUUID(),
      conversationId: run.conversationId,
      runId: run.id,
      sequence: (latest?.sequence ?? 0) + 1,
      payloadVersion: 1,
      payload,
      createdAt: timestamp,
    });
    db.insert(events).values({
      id: event.id,
      conversationId: event.conversationId,
      runId: event.runId,
      sequence: event.sequence,
      payloadVersion: event.payloadVersion,
      // Store provider replay blocks without reordering their keys. Canonical JSON
      // is only needed for submission/finalization equality, not transcript storage.
      payloadJson: JSON.stringify(event.payload),
      createdAt: event.createdAt,
    }).run();
    db.update(conversations).set({ updatedAt: timestamp }).where(eq(conversations.id, run.conversationId)).run();
    return event;
  }

  function findCall(runId: string, callId: string): ToolCall {
    for (const event of runEvents(runId)) {
      if (event.payload.kind === "assistant_message") {
        const call = event.payload.message.toolCalls.find(candidate => candidate.callId === callId);
        if (call) {
          return call;
        }
      }
    }
    conflict("Tool result has no matching call in this run.");
  }

  function readEvidence(row: typeof queryEvidence.$inferSelect) {
    const payload = decode(evidenceInputSchema, row.payloadJson);
    if (payload.evidence.resultId !== row.id) {
      throw new ConversationRepositoryError("invalid_record", "Stored evidence identity is inconsistent.");
    }
    return readRecord(storedEvidenceSchema, {
      ...payload,
      conversationId: row.conversationId,
      runId: row.runId,
      createdAt: row.createdAt,
    });
  }

  function recordResult(run: ConversationRun, result: StoredToolResult, evidence: EvidenceInput | undefined, timestamp: number) {
    findCall(run.id, result.callId);
    validateAppend(run.id, { role: "tool", callId: result.callId });
    const duplicate = runEvents(run.id).some(event =>
      event.payload.kind === "tool_result" && event.payload.result.callId === result.callId,
    );
    if (duplicate) {
      conflict("The tool call already has a result.");
    }
    if (result.payload.kind === "inline") {
      if (evidence) {
        conflict("Inline tool results cannot attach unreferenced evidence.");
      }
    } else {
      if (evidence) {
        if (evidence.evidence.resultId !== result.payload.evidenceId) {
          conflict("Tool result and evidence IDs do not match.");
        }
        const existing = db.select({ id: queryEvidence.id }).from(queryEvidence)
          .where(eq(queryEvidence.id, evidence.evidence.resultId)).get();
        if (existing) {
          conflict("This evidence ID has already been stored. Reference the existing record instead.");
        }
        db.insert(queryEvidence).values({
          id: evidence.evidence.resultId,
          conversationId: run.conversationId,
          runId: run.id,
          payloadJson: canonicalJson(evidence),
          createdAt: timestamp,
        }).run();
      }
      const row = db.select().from(queryEvidence).where(eq(queryEvidence.id, result.payload.evidenceId)).get();
      if (!row || row.conversationId !== run.conversationId || row.runId !== run.id) {
        conflict("Evidence must belong to the tool result's conversation and run.");
      }
      readEvidence(row);
    }
    return appendEvent(run, { kind: "tool_result", result }, timestamp);
  }

  function findSubmission(conversationId: string, clientMessageId: string, requestJson: string): StartRunResult | undefined {
    const row = db.select().from(runs).where(and(
      eq(runs.conversationId, conversationId), eq(runs.clientMessageId, clientMessageId),
    )).get();
    if (!row) {
      return undefined;
    }
    if (row.requestJson !== requestJson) {
      conflict("The submission ID was already used for different input.", "submission_mismatch");
    }
    return { run: readRun(row), created: false };
  }

  function createRun(input: z.infer<typeof retryRunSchema> | z.infer<typeof startRunSchema>, requestJson: string, source?: ConversationRun) {
    const timestamp = now();
    const runCount = db.select({ count: sql<number>`count(*)` }).from(runs)
      .where(eq(runs.conversationId, input.conversationId)).get()?.count ?? 0;
    const lastSequence = db.select({ sequence: sql<number>`coalesce(max(${events.sequence}), 0)` }).from(events)
      .where(eq(events.conversationId, input.conversationId)).get()?.sequence ?? 0;
    const active = db.select({ id: runs.id }).from(runs).where(and(
      eq(runs.conversationId, input.conversationId), eq(runs.status, "running"),
    )).get();
    assertRunAdmission({
      expectedRevision: input.expectedRevision,
      currentRevision: conversationRevision(runCount, lastSequence),
      deadline: input.deadline,
      now: timestamp,
      hasActiveRun: active !== undefined,
    });
    const run: ConversationRun = {
      id: randomUUID(),
      conversationId: input.conversationId,
      userMessageEventId: source?.userMessageEventId ?? randomUUID(),
      clientMessageId: input.clientMessageId,
      retryOfRunId: source?.id ?? null,
      status: "running",
      deadline: input.deadline,
      versions: input.versions,
      createdAt: timestamp,
      finishedAt: null,
      outcome: null,
    };
    db.insert(runs).values({
      id: run.id,
      conversationId: run.conversationId,
      userMessageEventId: run.userMessageEventId,
      clientMessageId: run.clientMessageId,
      retryOfRunId: run.retryOfRunId,
      status: run.status,
      deadline: run.deadline,
      createdAt: run.createdAt,
      finishedAt: null,
      versionsJson: canonicalJson(run.versions),
      requestJson,
      outcomeJson: null,
    }).run();
    if ("message" in input) {
      const event = appendEvent(run, { kind: "user_message", content: input.message }, timestamp);
      // Bind the run to the actual event identity allocated by appendEvent.
      run.userMessageEventId = event.id;
      db.update(runs).set({ userMessageEventId: event.id }).where(eq(runs.id, run.id)).run();
    }
    return { run, created: true };
  }

  function finalize(runId: string, input: FinishRunInput, timestamp: number): ConversationRun {
    const run = getRun(runId);
    const decision = checkRunFinalization({ run, events: runEvents(runId), requested: input });
    if (decision === "already_finished") {
      return run;
    }
    if (input.acknowledgment) {
      recordResult(run, input.acknowledgment, undefined, timestamp);
    }
    appendEvent(run, { kind: "outcome", outcome: input.outcome }, timestamp);
    db.update(runs).set({
      status: outcomeStatus(input.outcome),
      finishedAt: timestamp,
      outcomeJson: canonicalJson(input.outcome),
    }).where(eq(runs.id, runId)).run();
    return getRun(runId);
  }

  return {
    createConversation() {
      return perform(() => {
        const timestamp = now();
        const conversation = conversationSchema.parse({ id: randomUUID(), createdAt: timestamp, updatedAt: timestamp });
        db.insert(conversations).values(conversation).run();
        return conversation;
      });
    },
    getConversation(conversationId) {
      return perform(() => getConversation(identitySchema.parse(conversationId)));
    },
    findSubmission(input) {
      return perform(() => connection.transaction(() => {
        const parsed = z.strictObject({
          conversationId: identitySchema,
          clientMessageId: identitySchema,
          operation: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("message"), message: z.string().trim().min(1).max(2_000) }),
            z.strictObject({ kind: z.literal("retry"), runId: identitySchema }),
          ]),
        }).parse(input);
        getConversation(parsed.conversationId);
        return findSubmission(parsed.conversationId, parsed.clientMessageId, canonicalJson(parsed.operation))?.run ?? null;
      }).deferred());
    },
    startRun(input) {
      return perform(() => transaction(() => {
        const parsed = startRunSchema.parse(input);
        getConversation(parsed.conversationId);
        const requestJson = canonicalJson({ kind: "message", message: parsed.message });
        return findSubmission(parsed.conversationId, parsed.clientMessageId, requestJson) ?? createRun(parsed, requestJson);
      }));
    },
    retryRun(input) {
      return perform(() => transaction(() => {
        const parsed = retryRunSchema.parse(input);
        getConversation(parsed.conversationId);
        const requestJson = canonicalJson({ kind: "retry", runId: parsed.runId });
        const duplicate = findSubmission(parsed.conversationId, parsed.clientMessageId, requestJson);
        if (duplicate) {
          return duplicate;
        }
        const source = getRun(parsed.runId);
        // Terminal event sequence identifies the latest attempt without relying
        // on timestamps or random UUID ordering. Eventless retries are active.
        const lastEvent = db.select().from(events)
          .where(eq(events.conversationId, parsed.conversationId))
          .orderBy(sql`${events.sequence} desc`).get();
        const activeRun = db.select({ id: runs.id }).from(runs)
          .where(and(eq(runs.conversationId, parsed.conversationId), eq(runs.status, "running"))).get();
        assertRetryEligibility({
          source,
          conversationId: parsed.conversationId,
          latestRunId: lastEvent?.runId,
          hasActiveRun: activeRun !== undefined,
        });
        return createRun(parsed, requestJson, source);
      }));
    },
    appendContextNote(runId, content) {
      return perform(() => transaction(() => {
        const run = requireActiveRun(identitySchema.parse(runId));
        const payload = eventPayloadSchema.parse({ kind: "context_note", content });
        validateAppend(run.id, { role: "system" });
        return appendEvent(run, payload, now());
      }));
    },
    appendAssistant(runId, message) {
      return perform(() => transaction(() => {
        const run = requireActiveRun(identitySchema.parse(runId));
        const parsed = assistantMessageSchema.parse(message);
        validateAppend(run.id, parsed);
        const existingIds = new Set(runEvents(runId).flatMap(event =>
          event.payload.kind === "assistant_message" ? event.payload.message.toolCalls.map(call => call.callId) : [],
        ));
        if (parsed.toolCalls.some(call => existingIds.has(call.callId))) {
          conflict("Tool-call IDs must be unique within a run.");
        }
        return appendEvent(run, { kind: "assistant_message", message: parsed }, now());
      }));
    },
    recordAgentTrace(runId, trace: AgentTraceInput) {
      return perform(() => transaction(() => {
        // Debug capture may follow the terminal checkpoint; it cannot modify outcomes.
        const run = getRun(identitySchema.parse(runId));
        const latest = db.select({ sequence: sql<number>`coalesce(max(${agentTraces.sequence}), 0)` })
          .from(agentTraces).where(eq(agentTraces.runId, run.id)).get();
        db.insert(agentTraces).values({
          id: randomUUID(),
          runId: run.id,
          sequence: (latest?.sequence ?? 0) + 1,
          kind: trace.kind,
          payloadJson: JSON.stringify(trace.payload),
          startedAt: trace.startedAt,
          finishedAt: trace.finishedAt,
        }).run();
      }));
    },
    recordToolResult(runId, result, evidence) {
      return perform(() => transaction(() => {
        const run = requireActiveRun(identitySchema.parse(runId));
        const parsedResult = storedToolResultSchema.parse(result);
        const parsedEvidence = evidence === undefined ? undefined : evidenceInputSchema.parse(evidence);
        return recordResult(run, parsedResult, parsedEvidence, now());
      }));
    },
    finishRun(runId, input) {
      return perform(() => transaction(() => finalize(identitySchema.parse(runId), finishRunSchema.parse(input), now())));
    },
    loadHistory(conversationId) {
      // One WAL read snapshot keeps the tables consistent without reserving the
      // writer lock. Write operations still use BEGIN IMMEDIATE above.
      return perform(() => connection.transaction(() => {
        identitySchema.parse(conversationId);
        const conversation = getConversation(conversationId);
        return {
          conversation,
          runs: db.select().from(runs)
            .where(eq(runs.conversationId, conversationId))
            .orderBy(asc(runs.createdAt), asc(runs.id))
            .all().map(readRun),
          events: db.select().from(events)
            .where(eq(events.conversationId, conversationId))
            .orderBy(asc(events.sequence))
            .all().map(readEvent),
          evidence: db.select().from(queryEvidence)
            .where(eq(queryEvidence.conversationId, conversationId))
            .orderBy(asc(queryEvidence.createdAt), asc(queryEvidence.id))
            .all().map(readEvidence),
        };
      }).deferred());
    },
    getEvidence(conversationId, evidenceId) {
      return perform(() => {
        identitySchema.parse(conversationId);
        identitySchema.parse(evidenceId);
        getConversation(conversationId);
        const row = db.select().from(queryEvidence).where(and(
          eq(queryEvidence.id, evidenceId), eq(queryEvidence.conversationId, conversationId),
        )).get();
        if (!row) {
          throw new ConversationRepositoryError("not_found", "Evidence not found in this conversation.");
        }
        return readEvidence(row);
      });
    },
    interruptExpiredRuns(timestamp, graceMs = 0) {
      return perform(() => transaction(() => {
        z.number().int().nonnegative().safe().parse(timestamp);
        z.number().int().nonnegative().safe().parse(graceMs);
        const cutoff = Math.max(0, timestamp - graceMs);
        const expired = db.select().from(runs).where(and(eq(runs.status, "running"), lte(runs.deadline, cutoff))).all();
        for (const run of expired) {
          finalize(run.id, {
            outcome: { kind: "failure", status: "interrupted", error: { code: "interrupted", message: "The run ended without a saved outcome." } },
          }, timestamp);
        }
        return expired.length;
      }));
    },
    close() {
      if (!closed) {
        connection.close();
        closed = true;
      }
    },
  };
}
