export type { JsonValue } from "../contracts/json";
import type { JsonValue } from "../contracts/json";

export type QueryColumn = {
  name: string;
  type: string;
  mode?: string;
  fields?: QueryColumn[];
};

export type QueryPage = {
  complete: boolean;
  columns: QueryColumn[];
  rows: Record<string, JsonValue>[];
  nextPageToken?: string;
};

export type QueryStatistics = {
  bytesProcessed: string;
  bytesBilled: string;
  cacheHit: boolean;
};

export type DataQueryJob = {
  id: string;
  readPage(options: { pageToken?: string; maxRows: number; timeoutMs: number }): Promise<QueryPage>;
  statistics(): Promise<QueryStatistics>;
  cancel(): Promise<void>;
};

export type BigQueryGateway = {
  dryRun(sql: string): Promise<{ estimatedBytes: string }>;
  submit(sql: string, options: { maximumBytesBilled: string; timeoutMs: number }): Promise<DataQueryJob>;
};

export type ExecutionContext = {
  signal: AbortSignal;
  deadline: number;
  budget: {
    attemptsUsed: number;
    maxAttempts: number;
    resultBytesUsed: number;
    maxResultBytes: number;
  };
};

export type QueryEvidence = {
  resultId: string;
  sql: string;
  columns: QueryColumn[];
  rows: Record<string, JsonValue>[];
  payloadBytes: number;
  truncated: boolean;
  truncationReason?: "row_limit" | "byte_limit";
  jobId: string;
  estimatedBytes: string;
  statistics: QueryStatistics;
  elapsedMs: number;
  semanticGuideVersion: string;
};

export type QueryErrorCode =
  | "invalid_input" | "invalid_query" | "rejected_sql" | "unsupported_sql" | "processing_limit"
  | "execution_failed" | "result_size" | "cancelled" | "deadline" | "budget_exhausted";

export type QueryOutcome =
  | { ok: true; evidence: QueryEvidence }
  | { ok: false; error: { code: QueryErrorCode; message: string; jobId?: string } };

export type QueryExecutor = (request: { sql: unknown }, context: ExecutionContext) => Promise<QueryOutcome>;
