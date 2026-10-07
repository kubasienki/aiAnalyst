import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { createDataLayer } from "../src/server/config/data-layer";
import { createExecutionContext } from "../src/server/data/execution-context";
import { REFERENCE_QUERIES } from "../src/server/data/reference-queries";
import type { ExecutionContext, QueryEvidence } from "../src/server/data/types";

async function main() {
  loadEnvConfig(process.cwd(), true);
  const execute = createDataLayer();
  const context = createExecutionContext();
  async function run(name: string, sql: string, execution: ExecutionContext): Promise<QueryEvidence> {
    const result = await execute({ sql }, execution);
    if (!result.ok) throw new Error(`${name}: ${result.error.code}: ${result.error.message}`);
    assert.equal(result.evidence.truncated, false, `${name}: reference result must be complete`);
    console.log(`${name}: ${result.evidence.rows.length} rows; ${result.evidence.statistics.bytesProcessed} bytes processed; ${result.evidence.elapsedMs} ms; job ${result.evidence.jobId}`);
    return result.evidence;
  }
  const revenue = await run("December revenue", REFERENCE_QUERIES.decemberRevenue, context);
  assert.equal(revenue.rows[0].revenue_usd, 160555);
  const devices = await run("Period/device revenue", REFERENCE_QUERIES.revenueByDevice, context);
  assert.equal(devices.rows.filter(row => row.month === "202012").reduce((sum, row) => sum + Number(row.revenue_usd), 0), 160555);
  assert.equal(devices.rows.filter(row => row.month === "202011").reduce((sum, row) => sum + Number(row.revenue_usd), 0), 144260);
  const users = await run("December users", REFERENCE_QUERIES.decemberUsers, context);
  const products = await run("January products", REFERENCE_QUERIES.januaryProducts, context);
  assert.equal(products.rows.length, 10);
  assert.equal(products.rows[0].item_id, "9196615");
  assert.equal(products.rows[0].revenue_usd, 1276);

  // Independent verification batch: new executions do not bypass the service.
  const crosscheck = createExecutionContext();
  const identity = await run("Independent revenue identity", `SELECT
    SUM(IF(event_name = 'purchase', ecommerce.purchase_revenue_in_usd, 0)) AS revenue_usd
    FROM \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`
    WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231'`, crosscheck);
  assert.equal(identity.rows[0].revenue_usd, revenue.rows[0].revenue_usd);
  const groupedUsers = await run("Independent grouped users", `WITH visitors AS (
    SELECT user_pseudo_id FROM \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`
    WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231' AND user_pseudo_id IS NOT NULL
    GROUP BY user_pseudo_id) SELECT COUNT(*) AS users FROM visitors`, crosscheck);
  assert.equal(groupedUsers.rows[0].users, users.rows[0].users);
  const groupedProducts = await run("Independent product aggregation", `WITH product_rows AS (
    SELECT item.item_id, item.item_name, item.item_revenue_in_usd AS revenue
    FROM \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`, UNNEST(items) AS item
    WHERE _TABLE_SUFFIX BETWEEN '20210101' AND '20210131' AND event_name = 'purchase' AND item.item_id IS NOT NULL AND item.item_id NOT IN ('', '<Other>', '(not set)', '(data deleted)'))
    SELECT item_id, MAX(item_name) AS item_name, SUM(revenue) AS revenue_usd FROM product_rows
    GROUP BY item_id ORDER BY revenue_usd DESC, item_id LIMIT 10`, crosscheck);
  assert.deepEqual(groupedProducts.rows.map(row => [row.item_id, row.item_name, row.revenue_usd]),
    products.rows.map(row => [row.item_id, row.item_name, row.revenue_usd]));
  const sessions = await run("Observed December sessions", REFERENCE_QUERIES.decemberSessionConversion, crosscheck);
  assert.equal(sessions.rows[0].sessions, 133368);
  assert.equal(sessions.rows[0].purchasing_sessions, 2116);
  const parameters = await run("One-day event parameter discovery", REFERENCE_QUERIES.decemberFirstParameterInventory, createExecutionContext());
  assert.equal(parameters.rows.length, 33);
  assert.ok(parameters.rows.some(row => row.key === "ga_session_id"));
  const funnel = await run("Observed ordered December checkout", REFERENCE_QUERIES.decemberCheckout, createExecutionContext());
  assert.deepEqual({ ...funnel.rows[0] }, {
    checkout_sessions: 4362, shipping_sessions: 2491, payment_sessions: 1850, purchase_sessions: 1364,
  });
  console.log("Live data-layer verification passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Live verification failed.");
  process.exitCode = 1;
});
