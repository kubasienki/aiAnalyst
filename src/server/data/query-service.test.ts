import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryService } from "./query-service";
import { createExecutionContext } from "./execution-context";
import { REFERENCE_QUERIES } from "./reference-queries";
import type { BigQueryGateway, DataQueryJob, QueryPage } from "./types";

const sql = REFERENCE_QUERIES.decemberRevenue;
const columns = [{ name: "revenue_usd", type: "FLOAT" }];
function fixture(pages: QueryPage[] = [{ complete: true, columns, rows: [{ revenue_usd: 160555 }] }]) {
  const job: DataQueryJob = {
    id: "test-job", readPage: vi.fn().mockImplementation(async () => pages.shift()),
    statistics: vi.fn().mockResolvedValue({ bytesProcessed: "100", bytesBilled: "100", cacheHit: false }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const gateway: BigQueryGateway = {
    dryRun: vi.fn().mockResolvedValue({ estimatedBytes: "100" }),
    submit: vi.fn().mockResolvedValue(job),
  };
  return { job, gateway, execute: createQueryService({ gateway, maximumBytesBilled: "1073741824" }) };
}
afterEach(() => vi.useRealTimers());

describe("query service", () => {
  it("returns traceable results and consumes shared budgets", async () => {
    const { execute, gateway } = fixture(); const context = createExecutionContext();
    const result = await execute({ sql }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({ sql: sql.trim(), rows: [{ revenue_usd: 160555 }], jobId: "test-job", truncated: false, semanticGuideVersion: "ga4-sample-v1" });
    expect(context.budget.attemptsUsed).toBe(1);
    expect(context.budget.resultBytesUsed).toBe(result.evidence.payloadBytes);
    expect(gateway.submit).toHaveBeenCalledWith(sql.trim(), expect.objectContaining({ maximumBytesBilled: "1073741824" }));
  });
  it("rejects before contacting BigQuery and counts failed attempts", async () => {
    const { execute, gateway } = fixture(); const context = createExecutionContext();
    expect(await execute({ sql: "DELETE FROM x" }, context)).toMatchObject({ ok: false, error: { code: "rejected_sql" } });
    expect(context.budget.attemptsUsed).toBe(1); expect(gateway.dryRun).not.toHaveBeenCalled();
  });
  it("prevents execution after an excessive dry-run estimate", async () => {
    const { execute, gateway } = fixture(); vi.mocked(gateway.dryRun).mockResolvedValue({ estimatedBytes: "1073741825" });
    expect(await execute({ sql }, createExecutionContext())).toMatchObject({ ok: false, error: { code: "processing_limit" } });
    expect(gateway.submit).not.toHaveBeenCalled();
  });
  it("does not reset budgets after rejected queries", async () => {
    const { execute, gateway } = fixture(); const context = createExecutionContext();
    for (let i = 0; i < 4; i++) await execute({ sql: "DELETE FROM x" }, context);
    expect(await execute({ sql }, context)).toMatchObject({ ok: false, error: { code: "budget_exhausted" } });
    expect(gateway.dryRun).not.toHaveBeenCalled();
  });
  it("detects an extra row across pages without rewriting SQL", async () => {
    const page = (count: number, nextPageToken?: string): QueryPage => ({ complete: true, columns, rows: Array.from({ length: count }, () => ({ revenue_usd: 1 })), nextPageToken });
    const { execute } = fixture([...Array.from({ length: 8 }, (_, i) => page(25, String(i))), page(1)]);
    const result = await execute({ sql }, createExecutionContext());
    expect(result).toMatchObject({ ok: true, evidence: { sql: sql.trim(), truncated: true, truncationReason: "row_limit" } });
    if (result.ok) expect(result.evidence.rows).toHaveLength(200);
  });
  it("returns exactly 200 rows as complete when no extra row exists", async () => {
    const { execute } = fixture([{ complete: true, columns, rows: Array.from({ length: 200 }, () => ({ revenue_usd: 1 })) }]);
    expect(await execute({ sql }, createExecutionContext())).toMatchObject({ ok: true, evidence: { truncated: false } });
  });
  it("stops at the byte limit and records omitted rows", async () => {
    const { execute } = fixture([{ complete: true, columns, rows: [{ revenue_usd: 1 }, { revenue_usd: 2 }, { revenue_usd: 3 }] }]);
    const context = createExecutionContext(); context.budget.maxResultBytes = Buffer.byteLength(JSON.stringify({ columns, rows: [{ revenue_usd: 1 }] }));
    expect(await execute({ sql }, context)).toMatchObject({ ok: true, evidence: { truncated: true, truncationReason: "byte_limit", rows: [{ revenue_usd: 1 }] } });
  });
  it("rejects an individually oversized row", async () => {
    const { execute } = fixture([{ complete: true, columns, rows: [{ revenue_usd: "x".repeat(262144) }] }]);
    expect(await execute({ sql }, createExecutionContext())).toMatchObject({ ok: false, error: { code: "result_size" } });
  });
  it("supports empty results", async () => {
    const { execute } = fixture([{ complete: true, columns, rows: [] }]);
    expect(await execute({ sql }, createExecutionContext())).toMatchObject({ ok: true, evidence: { rows: [], truncated: false } });
  });
  it("keeps the result-byte budget across queries", async () => {
    const { execute, gateway } = fixture(); const context = createExecutionContext();
    context.budget.maxResultBytes = Buffer.byteLength(JSON.stringify({ columns, rows: [{ revenue_usd: 160555 }] }));
    expect((await execute({ sql }, context)).ok).toBe(true);
    expect(await execute({ sql }, context)).toMatchObject({ ok: false, error: { code: "budget_exhausted" } });
    expect(gateway.dryRun).toHaveBeenCalledOnce();
  });
  it("polls incomplete jobs before retrieving results", async () => {
    const { execute, job } = fixture([
      { complete: false, columns: [], rows: [] },
      { complete: true, columns, rows: [{ revenue_usd: 1 }] },
    ]);
    expect(await execute({ sql }, createExecutionContext())).toMatchObject({ ok: true, evidence: { rows: [{ revenue_usd: 1 }] } });
    expect(job.readPage).toHaveBeenCalledTimes(2);
  });
  it("does not call the gateway if already cancelled", async () => {
    const { execute, gateway } = fixture(); const controller = new AbortController(); controller.abort();
    expect(await execute({ sql }, createExecutionContext({ signal: controller.signal }))).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(gateway.dryRun).not.toHaveBeenCalled();
  });
  it("cancels a job arriving after cancellation during submission", async () => {
    const { execute, gateway, job } = fixture(); const controller = new AbortController();
    let resolve!: (job: DataQueryJob) => void;
    vi.mocked(gateway.submit).mockImplementation(() => new Promise(r => { resolve = r; controller.abort(); }));
    expect(await execute({ sql }, createExecutionContext({ signal: controller.signal }))).toMatchObject({ ok: false, error: { code: "cancelled" } });
    resolve(job); await Promise.resolve(); expect(job.cancel).toHaveBeenCalledOnce();
  });
  it("cancels during polling and prevents more pages", async () => {
    const { execute, job } = fixture(); const controller = new AbortController();
    vi.mocked(job.readPage).mockImplementation(async () => { controller.abort(); return { complete: false, rows: [], columns: [] }; });
    expect(await execute({ sql }, createExecutionContext({ signal: controller.signal }))).toMatchObject({ ok: false, error: { code: "cancelled", jobId: "test-job" } });
    expect(job.readPage).toHaveBeenCalledOnce(); expect(job.cancel).toHaveBeenCalledOnce();
  });
  it("bounds a stalled SDK call by the execution deadline", async () => {
    vi.useFakeTimers(); const { execute, gateway } = fixture();
    vi.mocked(gateway.dryRun).mockImplementation(() => new Promise(() => undefined));
    const result = execute({ sql }, createExecutionContext({ deadline: Date.now() + 20 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ ok: false, error: { code: "deadline" } });
    expect(gateway.submit).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a job arriving after the submission deadline", async () => {
    vi.useFakeTimers(); const { execute, gateway, job } = fixture();
    let resolve!: (job: DataQueryJob) => void;
    vi.mocked(gateway.submit).mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = execute({ sql }, createExecutionContext({ deadline: Date.now() + 20 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ ok: false, error: { code: "deadline" } });
    resolve(job); await Promise.resolve(); expect(job.cancel).toHaveBeenCalledOnce();
  });
  it("returns sanitized failures without retrying", async () => {
    const { execute, gateway } = fixture(); vi.mocked(gateway.dryRun).mockRejectedValue(new Error("secret credential text"));
    const result = await execute({ sql }, createExecutionContext());
    expect(result).toMatchObject({ ok: false, error: { code: "execution_failed" } });
    expect(JSON.stringify(result)).not.toContain("secret"); expect(gateway.dryRun).toHaveBeenCalledOnce();
  });
});
