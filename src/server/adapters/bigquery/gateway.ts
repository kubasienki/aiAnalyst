import "server-only";

import { z } from "zod";
import type { BigQuery, Job } from "@google-cloud/bigquery";
import type { BigQueryConfig } from "../../config/bigquery";
import { DataQueryError } from "../../data/errors";
import type { BigQueryGateway, DataQueryJob, QueryColumn, QueryPage } from "../../data/types";
import { normalizeRow } from "./normalize";

const byteCountSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().safe().transform(value => String(value)),
]);
const completedJobStatisticsSchema = z.object({
  statistics: z.object({
    totalBytesProcessed: byteCountSchema.optional(),
    query: z.object({
      totalBytesProcessed: byteCountSchema.optional(),
      totalBytesBilled: byteCountSchema,
      cacheHit: z.boolean(),
    }),
  }),
}).transform(({ statistics }, context) => {
  const bytesProcessed = statistics.query.totalBytesProcessed ?? statistics.totalBytesProcessed;
  if (bytesProcessed === undefined) {
    context.addIssue({ code: "custom", message: "Missing processed byte count." });
    return z.NEVER;
  }
  return {
    bytesProcessed,
    bytesBilled: statistics.query.totalBytesBilled,
    cacheHit: statistics.query.cacheHit,
  };
});

const dryRunMetadataSchema = z.object({
  statistics: z.object({ totalBytesProcessed: byteCountSchema }),
});

type SchemaField = {
  name?: string;
  type?: string;
  mode?: string;
  fields?: SchemaField[];
};

function mapColumns(fields: SchemaField[]): QueryColumn[] {
  return fields.map(field => {
    if (!field.name || !field.type) {
      throw new Error("Missing result schema.");
    }
    return {
      name: field.name,
      type: field.type,
      ...(field.mode ? { mode: field.mode } : {}),
      ...(field.fields ? { fields: mapColumns(field.fields) } : {}),
    };
  });
}

function readResultPage(
  job: Job,
  options: Parameters<DataQueryJob["readPage"]>[0],
): Promise<QueryPage> {
  // The SDK promise rejects on jobComplete=false when timeoutMs is set.
  // Its callback retains the response, allowing the service to poll explicitly.
  return new Promise((resolve, reject) => {
    job.getQueryResults({
      autoPaginate: false,
      maxResults: options.maxRows,
      pageToken: options.pageToken,
      timeoutMs: Math.min(options.timeoutMs, 1000),
      wrapIntegers: true,
    }, (error, rows, next, response) => {
      if (response?.jobComplete === false) {
        resolve({ complete: false, rows: [], columns: [] });
        return;
      }
      if (error) {
        reject(error);
        return;
      }

      try {
        const columns = mapColumns(response?.schema?.fields || []);
        if (!rows || (rows.length && !columns.length)) {
          throw new Error("Missing result schema.");
        }
        resolve({
          complete: true,
          columns,
          rows: rows.map(row => normalizeRow(row, columns)),
          ...(next?.pageToken ? { nextPageToken: next.pageToken } : {}),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createBigQueryGateway(client: BigQuery, config: BigQueryConfig): BigQueryGateway {
  const queryDefaults = { location: config.location, useLegacySql: false };

  return {
    async dryRun(sql) {
      const [job] = await client.createQueryJob({ ...queryDefaults, query: sql, dryRun: true });
      const parsed = dryRunMetadataSchema.safeParse(job.metadata);
      if (!parsed.success) {
        throw new DataQueryError("execution_failed", "BigQuery returned invalid processing metadata.");
      }
      return { estimatedBytes: parsed.data.statistics.totalBytesProcessed };
    },

    async submit(sql, options) {
      const [job] = await client.createQueryJob({
        ...queryDefaults,
        query: sql,
        maximumBytesBilled: options.maximumBytesBilled,
        jobTimeoutMs: options.timeoutMs,
      });
      if (!job.id) {
        throw new Error("Missing job ID.");
      }

      return {
        id: job.id,
        readPage: pageOptions => readResultPage(job, pageOptions),
        async statistics() {
          const [metadata] = await job.getMetadata();
          const parsed = completedJobStatisticsSchema.safeParse(metadata);
          if (!parsed.success) {
            throw new DataQueryError("execution_failed", "BigQuery returned invalid query statistics.");
          }
          return parsed.data;
        },
        async cancel() {
          await job.cancel();
        },
      };
    },
  };
}

export function sanitizeBigQueryError(error: unknown): DataQueryError {
  const reasons: unknown[] = [];
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    for (const detail of error.errors) {
      if (detail && typeof detail === "object" && "reason" in detail) {
        reasons.push(detail.reason);
      }
    }
  }

  if (reasons.includes("billingTierLimitExceeded") || reasons.includes("quotaExceeded")) {
    return new DataQueryError("processing_limit", "BigQuery rejected the processing or quota limit. Narrow the query.");
  }
  return new DataQueryError("execution_failed", "BigQuery could not complete this query. Check the query and project access.");
}
