import "server-only";

import type { BigQuery } from "@google-cloud/bigquery";
import type { BigQueryConfig } from "../../config/bigquery";
import { DataQueryError } from "../../data/errors";
import type { BigQueryGateway, QueryColumn, QueryPage } from "../../data/types";
import { normalizeRow } from "./normalize";

function columns(fields: { name?: string; type?: string; mode?: string; fields?: unknown[] }[]): QueryColumn[] {
  return fields.map(field => {
    if (!field.name || !field.type) throw new Error("Missing result schema.");
    return {
      name: field.name, type: field.type,
      ...(field.mode ? { mode: field.mode } : {}),
      ...(field.fields ? { fields: columns(field.fields as Parameters<typeof columns>[0]) } : {}),
    };
  });
}

export function createBigQueryGateway(client: BigQuery, config: BigQueryConfig): BigQueryGateway {
  const base = { location: config.location, useLegacySql: false };
  return {
    async dryRun(sql) {
      const [job] = await client.createQueryJob({ ...base, query: sql, dryRun: true });
      const estimate = job.metadata.statistics?.totalBytesProcessed;
      if (estimate === undefined) throw new Error("Missing processing estimate.");
      return { estimatedBytes: String(estimate) };
    },
    async submit(sql, options) {
      const [job] = await client.createQueryJob({
        ...base, query: sql, maximumBytesBilled: options.maximumBytesBilled,
        jobTimeoutMs: options.timeoutMs,
      });
      if (!job.id) throw new Error("Missing job ID.");
      return {
        id: job.id,
        async readPage({ pageToken, maxRows, timeoutMs }) {
          // The SDK rejects its promise on jobComplete=false when timeoutMs is set.
          // Its callback retains that response, letting our service poll explicitly.
          return new Promise<QueryPage>((resolve, reject) => {
            job.getQueryResults({
              autoPaginate: false, maxResults: maxRows, pageToken,
              timeoutMs: Math.min(timeoutMs, 1000), wrapIntegers: true,
            }, (error, rows, next, response) => {
              if (response?.jobComplete === false) { resolve({ complete: false, rows: [], columns: [] }); return; }
              if (error) { reject(error); return; }
              try {
                const schema = columns(response?.schema?.fields || []);
                if (!rows || (rows.length && !schema.length)) throw new Error("Missing result schema.");
                resolve({ complete: true, columns: schema, rows: rows.map(row => normalizeRow(row, schema)),
                  ...(next?.pageToken ? { nextPageToken: next.pageToken } : {}) });
              } catch (failure) { reject(failure); }
            });
          });
        },
        async statistics() {
          const [metadata] = await job.getMetadata();
          const stats = metadata.statistics?.query;
          return {
            bytesProcessed: String(stats?.totalBytesProcessed ?? metadata.statistics?.totalBytesProcessed ?? "0"),
            bytesBilled: String(stats?.totalBytesBilled ?? "0"), cacheHit: stats?.cacheHit ?? false,
          };
        },
        async cancel() { await job.cancel(); },
      };
    },
  };
}

export function sanitizeBigQueryError(error: unknown): DataQueryError {
  const reasons = error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)
    ? error.errors.map(item => item && typeof item === "object" && "reason" in item ? item.reason : undefined) : [];
  return reasons.includes("billingTierLimitExceeded") || reasons.includes("quotaExceeded")
    ? new DataQueryError("processing_limit", "BigQuery rejected the processing or quota limit. Narrow the query.")
    : new DataQueryError("execution_failed", "BigQuery could not complete this query. Check the query and project access.");
}
