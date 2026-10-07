import "server-only";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readPersistenceConfig } from "../config/persistence";
import { z } from "zod";
import {
  debugRunSummarySchema, debugRunMetadataSchema, debugEventSchema, debugEvidenceSchema, debugTraceSchema,
  type DebugRunSummary, type DebugRun,
} from "../../shared/agent-debug";

const summaryRowSchema = debugRunSummarySchema.omit({ versions: true, outcome: true, userEvent: true }).extend({
  versionsJson: z.string(),
  outcomeJson: z.string().nullable(),
  userEventJson: z.string().nullable(),
});
const runRowSchema = debugRunMetadataSchema.omit({ versions: true, outcome: true, request: true });
const eventRowSchema = debugEventSchema.omit({ payload: true });
const evidenceRowSchema = debugEvidenceSchema.omit({ data: true });
const traceRowSchema = debugTraceSchema.omit({ payload: true });

function requireLocalDebugMode(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("not_available");
  }
}

function openReadOnlyDatabase(): Database.Database {
  requireLocalDebugMode();
  const { databasePath } = readPersistenceConfig();
  if (!existsSync(databasePath)) {
    throw new Error("database_missing");
  }
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { invalidJson: true, raw: value };
  }
}

export function listDebugRuns(): DebugRunSummary[] {
  const database = openReadOnlyDatabase();
  try {
    return database.prepare(`
      SELECT r.id, r.conversation_id AS conversationId, r.status, r.created_at AS createdAt,
        r.finished_at AS finishedAt, r.retry_of_run_id AS retryOfRunId,
        r.versions_json AS versionsJson, r.outcome_json AS outcomeJson,
        (SELECT payload_json FROM conversation_events e WHERE e.run_id = r.id AND json_extract(e.payload_json, '$.kind') = 'user_message' ORDER BY sequence LIMIT 1) AS userEventJson
      FROM runs r ORDER BY r.created_at DESC LIMIT 200
    `).all().map(row => {
      const record = summaryRowSchema.parse(row);
      return {
        id: record.id,
        conversationId: record.conversationId,
        status: record.status,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt,
        retryOfRunId: record.retryOfRunId,
        versions: parseJson(record.versionsJson),
        outcome: record.outcomeJson === null ? null : parseJson(record.outcomeJson),
        userEvent: record.userEventJson === null ? null : parseJson(record.userEventJson),
      };
    });
  } finally {
    database.close();
  }
}

export function readDebugRun(runId: string): DebugRun | null {
  const database = openReadOnlyDatabase();
  try {
    const runRow = database.prepare(`
      SELECT id, conversation_id AS conversationId, user_message_event_id AS userMessageEventId,
        retry_of_run_id AS retryOfRunId, request_json AS requestJson, status, deadline,
        versions_json AS versionsJson, created_at AS createdAt, finished_at AS finishedAt,
        outcome_json AS outcomeJson
      FROM runs WHERE id = ?
    `).get(runId);
    if (!runRow) {
      return null;
    }
    const run = runRowSchema.parse(runRow);
    const events = database.prepare(`
      SELECT id, sequence, payload_version AS payloadVersion, payload_json AS payloadJson, created_at AS createdAt
      FROM conversation_events WHERE run_id = ? ORDER BY sequence
    `).all(runId).map(row => {
      const event = eventRowSchema.parse(row);
      return { ...event, payload: parseJson(event.payloadJson) };
    });
    const evidence = database.prepare(`
      SELECT id, payload_json AS payloadJson, created_at AS createdAt FROM query_evidence WHERE run_id = ? ORDER BY created_at, id
    `).all(runId).map(row => {
      const item = evidenceRowSchema.parse(row);
      return { ...item, data: parseJson(item.payloadJson) };
    });
    const traceTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_traces'").get();
    const traceRows = traceTable ? database.prepare(`
      SELECT id, sequence, kind, payload_json AS payloadJson, started_at AS startedAt, finished_at AS finishedAt
      FROM agent_traces WHERE run_id = ? ORDER BY sequence
    `).all(runId) : [];
    const traces = traceRows.map(row => {
      const trace = traceRowSchema.parse(row);
      return { ...trace, payload: parseJson(trace.payloadJson) };
    });
    return {
      run: {
        ...run,
        request: parseJson(run.requestJson),
        versions: parseJson(run.versionsJson),
        outcome: run.outcomeJson === null ? null : parseJson(run.outcomeJson),
      },
      events,
      evidence,
      traces,
      contextCapture: traces.some(trace => trace.kind === "model_call")
        ? "Available model traces contain exact provider request bodies; best-effort capture may omit some calls."
        : "Historical context is represented by stored events and evidence; no exact provider request bodies were captured.",
    };
  } finally {
    database.close();
  }
}
