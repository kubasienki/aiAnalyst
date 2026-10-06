import { BigQuery } from "@google-cloud/bigquery";
import { describe, expect, it, vi } from "vitest";
import { createBigQueryGateway, sanitizeBigQueryError } from "./gateway";

const config = { projectId: "test-project", location: "US" as const, maximumBytesBilled: "1073741824" };
function fixture() {
  const job = {
    id: "sdk-job", metadata: { statistics: { totalBytesProcessed: "125" } },
    getQueryResults: vi.fn(), cancel: vi.fn().mockResolvedValue([]),
    getMetadata: vi.fn().mockResolvedValue([{ statistics: { query: { totalBytesProcessed: "125", totalBytesBilled: "200", cacheHit: true } } }]),
  };
  const createQueryJob = vi.fn().mockResolvedValue([job]);
  const gateway = createBigQueryGateway({ createQueryJob } as unknown as BigQuery, config);
  return { gateway, job, createQueryJob };
}

describe("BigQuery gateway", () => {
  it("uses GoogleSQL, location, cost ceiling, and timeout without disabling caching", async () => {
    const { gateway, createQueryJob } = fixture();
    expect(await gateway.dryRun("SELECT 1")).toEqual({ estimatedBytes: "125" });
    const active = await gateway.submit("SELECT 1", { maximumBytesBilled: "1000", timeoutMs: 250 });
    expect(createQueryJob).toHaveBeenLastCalledWith({ query: "SELECT 1", location: "US", useLegacySql: false, maximumBytesBilled: "1000", jobTimeoutMs: 250 });
    expect(await active.statistics()).toEqual({ bytesProcessed: "125", bytesBilled: "200", cacheHit: true });
  });
  it("retains incomplete responses despite the SDK timeout error", async () => {
    const { gateway, job } = fixture();
    job.getQueryResults.mockImplementation((_options, callback) => callback(new Error("timeout"), null, {}, { jobComplete: false }));
    const active = await gateway.submit("SELECT 1", { maximumBytesBilled: "1000", timeoutMs: 250 });
    expect(await active.readPage({ maxRows: 25, timeoutMs: 200 })).toEqual({ complete: false, columns: [], rows: [] });
  });
  it("paginates explicitly and normalizes actual SDK wrappers", async () => {
    const { gateway, job } = fixture();
    job.getQueryResults.mockImplementation((_options, callback) => callback(null,
      [{ count: BigQuery.int("9007199254740993"), date: BigQuery.date("2020-12-01") }],
      { pageToken: "next" }, { jobComplete: true, schema: { fields: [{ name: "count", type: "INTEGER" }, { name: "date", type: "DATE" }] } }));
    const active = await gateway.submit("SELECT 1", { maximumBytesBilled: "1000", timeoutMs: 250 });
    expect(await active.readPage({ pageToken: "previous", maxRows: 25, timeoutMs: 200 })).toMatchObject({ nextPageToken: "next", rows: [{ count: "9007199254740993", date: "2020-12-01" }] });
    expect(job.getQueryResults).toHaveBeenCalledWith(expect.objectContaining({ autoPaginate: false, wrapIntegers: true, maxResults: 25, pageToken: "previous" }), expect.any(Function));
    await active.cancel(); expect(job.cancel).toHaveBeenCalledOnce();
  });
  it("does not expose raw SDK errors", () => {
    expect(sanitizeBigQueryError(new Error("secret"))).toMatchObject({ code: "execution_failed" });
    expect(sanitizeBigQueryError({ errors: [{ reason: "quotaExceeded" }] })).toMatchObject({ code: "processing_limit" });
  });
});
