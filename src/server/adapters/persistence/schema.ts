import "server-only";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  userMessageEventId: text("user_message_event_id").notNull(),
  clientMessageId: text("client_message_id").notNull(),
  retryOfRunId: text("retry_of_run_id").references((): AnySQLiteColumn => runs.id),
  requestJson: text("request_json").notNull(),
  status: text("status").notNull(),
  deadline: integer("deadline").notNull(),
  versionsJson: text("versions_json").notNull(),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  outcomeJson: text("outcome_json"),
}, table => [
  uniqueIndex("runs_submission").on(table.conversationId, table.clientMessageId),
  uniqueIndex("runs_active").on(table.conversationId).where(sql`${table.status} = 'running'`),
]);

export const events = sqliteTable("conversation_events", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  runId: text("run_id").notNull().references(() => runs.id),
  sequence: integer("sequence").notNull(),
  payloadVersion: integer("payload_version").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [uniqueIndex("events_sequence").on(table.conversationId, table.sequence)]);

export const queryEvidence = sqliteTable("query_evidence", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  runId: text("run_id").notNull().references(() => runs.id),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [index("evidence_conversation").on(table.conversationId)]);

export const agentTraces = sqliteTable("agent_traces", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
}, table => [uniqueIndex("agent_traces_sequence").on(table.runId, table.sequence)]);

// Assessment-only initialization. Existing tables are never upgraded or deleted.
export const INITIALIZE_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_message_event_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  retry_of_run_id TEXT REFERENCES runs(id),
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','waiting_for_user','failed','cancelled','interrupted')),
  deadline INTEGER NOT NULL,
  versions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_submission ON runs(conversation_id, client_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_active ON runs(conversation_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS conversation_events (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_sequence ON conversation_events(conversation_id, sequence);
CREATE TABLE IF NOT EXISTS query_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_conversation ON query_evidence(conversation_id);
CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  kind TEXT NOT NULL CHECK(kind IN ('model_call','tool_call')),
  payload_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_traces_sequence ON agent_traces(run_id, sequence);
`;
