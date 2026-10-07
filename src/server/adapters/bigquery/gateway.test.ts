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
  it.each([
    null,
    {},
    { statistics: { query: { totalBytesProcessed: "1", totalBytesBilled: "1" } } },
    { statistics: { query: { totalBytesProcessed: "invalid", totalBytesBilled: "1", cacheHit: false } } },
    { statistics: { query: { totalBytesProcessed: "1", totalBytesBilled: -1, cacheHit: false } } },
    { statistics: { query: { totalBytesProcessed: 9_007_199_254_740_992, totalBytesBilled: "1", cacheHit: false } } },
    { statistics: { query: { totalBytesProcessed: "1", totalBytesBilled: "1", cacheHit: "false" } } },
  ])("rejects missing or malformed statistics without fabricating zero values", async metadata => {
    const { gateway, job } = fixture();
    job.getMetadata.mockResolvedValue([metadata]);
    const active = await gateway.submit("SELECT 1", { maximumBytesBilled: "1000", timeoutMs: 250 });
    await expect(active.statistics()).rejects.toMatchObject({ code: "execution_failed" });
  });

  it.each([undefined, null, "invalid", -1, 1.5, 9_007_199_254_740_992])("rejects invalid dry-run byte count %s", async totalBytesProcessed => {
    const { gateway, createQueryJob } = fixture();
    createQueryJob.mockResolvedValue([{ metadata: { statistics: { totalBytesProcessed } } }]);
    await expect(gateway.dryRun("SELECT 1")).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("preserves genuine zero statistics and exact large numeric strings", async () => {
    const { gateway, job } = fixture();
    job.getMetadata.mockResolvedValue([{ statistics: { query: {
      totalBytesProcessed: "9007199254740993", totalBytesBilled: "0", cacheHit: false,
    } } }]);
    const active = await gateway.submit("SELECT 1", { maximumBytesBilled: "1000", timeoutMs: 250 });
    expect(await active.statistics()).toEqual({ bytesProcessed: "9007199254740993", bytesBilled: "0", cacheHit: false });
    job.getMetadata.mockResolvedValue([{ statistics: { query: {
      totalBytesProcessed: "0", totalBytesBilled: "0", cacheHit: true,
    } } }]);
    expect(await active.statistics()).toEqual({ bytesProcessed: "0", bytesBilled: "0", cacheHit: true });
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
    const invalid = sanitizeBigQueryError({ errors: [{ reason: "invalidQuery", message: "secret project name and raw SQL" }] });
    expect(invalid.code).toBe("invalid_query");
    expect(invalid.message).not.toContain("secret");
  });
});
