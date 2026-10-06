import "server-only";

import { randomUUID } from "node:crypto";
import { DataQueryError } from "./errors";
import { checkExecution, withinDeadline } from "./execution-context";
import { SEMANTIC_GUIDE_VERSION } from "./semantic-guide";
import { validateSql } from "./sql-policy";
import type {
  BigQueryGateway,
  DataQueryJob,
  ExecutionContext,
  JsonValue,
  QueryColumn,
  QueryOutcome,
} from "./types";

const MAX_ROWS = 200;
const PAGE_SIZE = 25;
const MAX_PAYLOAD_BYTES = 256 * 1024;

type QueryServiceDependencies = {
  gateway: BigQueryGateway;
  maximumBytesBilled: string;
  mapExecutionError?: (error: unknown) => DataQueryError;
};

type CollectedResult = {
  columns: QueryColumn[];
  rows: Record<string, JsonValue>[];
  payloadBytes: number;
  truncationReason?: "row_limit" | "byte_limit";
};

function payloadSize(columns: QueryColumn[], rows: Record<string, JsonValue>[]): number {
  return Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8");
}

function cancelBestEffort(job: DataQueryJob): void {
  // Cleanup must not replace the original failure. Cancellation is not guaranteed.
  void job.cancel().catch(() => undefined);
}

async function collectResults(
  job: DataQueryJob,
  context: ExecutionContext,
  byteLimit: number,
): Promise<CollectedResult> {
  let columns: QueryColumn[] = [];
  const rows: Record<string, JsonValue>[] = [];
  let pageToken: string | undefined;
  let truncationReason: CollectedResult["truncationReason"];

  for (;;) {
    checkExecution(context);
    const page = await withinDeadline(job.readPage({
      pageToken,
      // Fetch one extra row to distinguish a complete result from truncation.
      maxRows: Math.min(PAGE_SIZE, MAX_ROWS + 1 - rows.length),
      timeoutMs: Math.max(1, context.deadline - Date.now()),
    }), context);
    checkExecution(context);

    if (!page.complete) {
      await withinDeadline(new Promise<void>(resolve => setTimeout(resolve, 100)), context);
      continue;
    }

    if (!columns.length) {
      columns = page.columns;
    }
    if (payloadSize(columns, rows) > byteLimit) {
      throw new DataQueryError("result_size", "Result schema exceeds the payload budget.");
    }

    for (const row of page.rows) {
      if (rows.length === MAX_ROWS) {
        truncationReason = "row_limit";
        break;
      }
      if (payloadSize(columns, [row]) > byteLimit) {
        throw new DataQueryError("result_size", "A result row exceeds the payload budget. Select smaller values.");
      }

      rows.push(row);
      if (payloadSize(columns, rows) > byteLimit) {
        rows.pop();
        truncationReason = "byte_limit";
        break;
      }
    }

    if (truncationReason || !page.nextPageToken) {
      break;
    }
    pageToken = page.nextPageToken;
  }

  return {
    columns,
    rows,
    payloadBytes: payloadSize(columns, rows),
    ...(truncationReason ? { truncationReason } : {}),
  };
}

export function createQueryService(dependencies: QueryServiceDependencies) {
  if (!/^[1-9]\d*$/.test(dependencies.maximumBytesBilled)) {
    throw new Error("Invalid processing ceiling.");
  }

  return async function executeQuery(
    request: { sql: unknown },
    context: ExecutionContext,
  ): Promise<QueryOutcome> {
    const startedAt = Date.now();
    let job: DataQueryJob | undefined;
    let executionFinished = false;

    try {
      checkExecution(context);
      if (context.budget.attemptsUsed >= context.budget.maxAttempts) {
        throw new DataQueryError("budget_exhausted", "The query attempt budget was reached.");
      }
      // Reserve synchronously before any await; rejected SQL also consumes an attempt.
      context.budget.attemptsUsed++;
      const sql = validateSql(request?.sql);
      const byteLimit = Math.min(
        MAX_PAYLOAD_BYTES,
        context.budget.maxResultBytes - context.budget.resultBytesUsed,
      );
      if (byteLimit <= 0) {
        throw new DataQueryError("budget_exhausted", "The execution result-byte budget was reached.");
      }

      const estimate = await withinDeadline(dependencies.gateway.dryRun(sql), context);
      checkExecution(context);
      if (BigInt(estimate.estimatedBytes) > BigInt(dependencies.maximumBytesBilled)) {
        throw new DataQueryError("processing_limit", "Estimated processing exceeds the query ceiling. Narrow dates or selected fields.");
      }

      const submission = dependencies.gateway.submit(sql, {
        maximumBytesBilled: dependencies.maximumBytesBilled,
        timeoutMs: Math.max(1, context.deadline - Date.now()),
      });
      // Submission can outlive our wait. Cancel a job that arrives after failure.
      // The rejection is handled by the awaited submission below.
      void submission.then(submittedJob => {
        if (executionFinished) {
          cancelBestEffort(submittedJob);
        }
      }, () => undefined);
      job = await withinDeadline(submission, context);
      checkExecution(context);

      const result = await collectResults(job, context, byteLimit);
      const statistics = await withinDeadline(job.statistics(), context);
      checkExecution(context);

      // Other callers may have consumed the shared budget during our awaits.
      if (context.budget.resultBytesUsed + result.payloadBytes > context.budget.maxResultBytes) {
        throw new DataQueryError("budget_exhausted", "The execution result-byte budget was reached.");
      }
      context.budget.resultBytesUsed += result.payloadBytes;
      executionFinished = true;

      return {
        ok: true,
        evidence: {
          resultId: randomUUID(),
          sql,
          ...result,
          truncated: Boolean(result.truncationReason),
          jobId: job.id,
          estimatedBytes: estimate.estimatedBytes,
          statistics,
          elapsedMs: Date.now() - startedAt,
          semanticGuideVersion: SEMANTIC_GUIDE_VERSION,
        },
      };
    } catch (error) {
      executionFinished = true;
      if (job) {
        cancelBestEffort(job);
      }
      const failure = error instanceof DataQueryError
        ? error
        : dependencies.mapExecutionError?.(error)
          ?? new DataQueryError("execution_failed", "The analytical query could not complete.");

      return {
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          ...(job ? { jobId: job.id } : {}),
        },
      };
    }
  };
}
