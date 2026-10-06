import "server-only";

import { randomUUID } from "node:crypto";
import { DataQueryError } from "./errors";
import { checkExecution, withinDeadline } from "./execution-context";
import { SEMANTIC_GUIDE_VERSION } from "./semantic-guide";
import { validateSql } from "./sql-policy";
import type { BigQueryGateway, DataQueryJob, ExecutionContext, QueryOutcome, QueryColumn, JsonValue } from "./types";

const MAX_ROWS = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

export function createQueryService(dependencies: {
  gateway: BigQueryGateway;
  maximumBytesBilled: string;
  mapExecutionError?: (error: unknown) => DataQueryError;
}) {
  if (!/^[1-9]\d*$/.test(dependencies.maximumBytesBilled)) throw new Error("Invalid processing ceiling.");

  return async function executeQuery(request: { sql: unknown }, context: ExecutionContext): Promise<QueryOutcome> {
    const started = Date.now();
    let job: DataQueryJob | undefined;
    let finished = false;
    const cancel = (active: DataQueryJob) => { void active.cancel().catch(() => undefined); };
    try {
      checkExecution(context);
      if (context.budget.attemptsUsed >= context.budget.maxAttempts) throw new DataQueryError("budget_exhausted", "The query attempt budget was reached.");
      context.budget.attemptsUsed++;
      const sql = validateSql(request?.sql);
      const limit = Math.min(MAX_PAYLOAD_BYTES, context.budget.maxResultBytes - context.budget.resultBytesUsed);
      if (limit <= 0) throw new DataQueryError("budget_exhausted", "The execution result-byte budget was reached.");
      const estimate = await withinDeadline(dependencies.gateway.dryRun(sql), context);
      checkExecution(context);
      if (BigInt(estimate.estimatedBytes) > BigInt(dependencies.maximumBytesBilled)) {
        throw new DataQueryError("processing_limit", "Estimated processing exceeds the query ceiling. Narrow dates or selected fields.");
      }
      const submission = dependencies.gateway.submit(sql, {
        maximumBytesBilled: dependencies.maximumBytesBilled, timeoutMs: Math.max(1, context.deadline - Date.now()),
      });
      // A pending submission can outlive cancellation. Cancel its eventual job too.
      void submission.then(active => { if (finished) cancel(active); }, () => undefined);
      job = await withinDeadline(submission, context);
      checkExecution(context);
      let columns: QueryColumn[] = [];
      const rows: Record<string, JsonValue>[] = [];
      let pageToken: string | undefined;
      let truncationReason: "row_limit" | "byte_limit" | undefined;
      const size = () => Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8");
      for (;;) {
        checkExecution(context);
        const page = await withinDeadline(job.readPage({ pageToken, maxRows: Math.min(25, MAX_ROWS + 1 - rows.length), timeoutMs: Math.max(1, context.deadline - Date.now()) }), context);
        checkExecution(context);
        if (!page.complete) {
          await withinDeadline(new Promise<void>(resolve => setTimeout(resolve, 100)), context);
          continue;
        }
        if (!columns.length) columns = page.columns;
        if (size() > limit) throw new DataQueryError("result_size", "Result schema exceeds the payload budget.");
        for (const row of page.rows) {
          if (rows.length === MAX_ROWS) { truncationReason = "row_limit"; break; }
          if (Buffer.byteLength(JSON.stringify({ columns, rows: [row] }), "utf8") > limit) {
            throw new DataQueryError("result_size", "A result row exceeds the payload budget. Select smaller values.");
          }
          rows.push(row);
          if (size() > limit) { rows.pop(); truncationReason = "byte_limit"; break; }
        }
        if (truncationReason || !page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
      const statistics = await withinDeadline(job.statistics(), context);
      checkExecution(context);
      const payloadBytes = size();
      // Reserve against the shared budget again after awaits to handle concurrent callers.
      if (context.budget.resultBytesUsed + payloadBytes > context.budget.maxResultBytes) {
        throw new DataQueryError("budget_exhausted", "The execution result-byte budget was reached.");
      }
      context.budget.resultBytesUsed += payloadBytes;
      finished = true;
      return { ok: true, evidence: {
        resultId: randomUUID(), sql, columns, rows, payloadBytes,
        truncated: Boolean(truncationReason), ...(truncationReason ? { truncationReason } : {}),
        jobId: job.id, estimatedBytes: estimate.estimatedBytes, statistics,
        elapsedMs: Date.now() - started, semanticGuideVersion: SEMANTIC_GUIDE_VERSION,
      } };
    } catch (error) {
      finished = true;
      if (job) cancel(job);
      const failure = error instanceof DataQueryError ? error
        : dependencies.mapExecutionError?.(error) ?? new DataQueryError("execution_failed", "The analytical query could not complete.");
      return { ok: false, error: { code: failure.code, message: failure.message, ...(job ? { jobId: job.id } : {}) } };
    }
  };
}
