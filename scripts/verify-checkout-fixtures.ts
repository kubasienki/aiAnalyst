import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { createBigQueryClient } from "../src/server/adapters/bigquery/client";
import { readBigQueryConfig } from "../src/server/config/bigquery";
import { orderedCheckoutSql, checkoutStageRowsSql, checkoutTransitionRowsSql } from "../src/server/data/reference-queries";

type FixtureEvent = { user: string; session: number | null; name: string; timestamp: number; date: string };
const stages = ["begin_checkout", "add_shipping_info", "add_payment_info", "purchase"];

function journey(user: string, session: number | null, timestamps: number[], date = "20201210"): FixtureEvent[] {
  return timestamps.map((timestamp, index) => ({ user, session, name: stages[index], timestamp, date }));
}

const fixtures: FixtureEvent[] = [
  ...journey("repeat", 1, [10, 20, 30, 40]),
  { user: "repeat", session: 1, name: "add_shipping_info", timestamp: 5, date: "20201210" },
  { user: "repeat", session: 1, name: "begin_checkout", timestamp: 35, date: "20201210" },
  ...journey("other-user-same-id", 1, [10, 20, 30, 40]),
  ...journey("tied", 3, [10, 10, 20, 30]),
  ...journey("out-of-order", 4, [30, 20, 40, 50]),
  ...journey("missing-entry", 5, [0, 10, 20, 30]).filter(event => event.name !== "begin_checkout"),
  ...journey("boundary", 6, [10, 20, 30, 40]).map(event => event.name === "purchase" ? { ...event, date: "20210101" } : event),
  ...journey("duplicate", 7, [10, 20, 30, 40]),
  { user: "duplicate", session: 7, name: "purchase", timestamp: 40, date: "20201210" },
  ...journey("missing-session", null, [10, 20, 30, 40]),
  ...journey("", 9, [10, 20, 30, 40]),
];

// Independent sequential-event oracle, rather than another set of SQL minima.
function expectedCounts() {
  const sessions = new Map<string, FixtureEvent[]>();
  for (const event of fixtures) {
    if (!event.user || event.session === null || event.date < "20201201" || event.date > "20201231") continue;
    const key = JSON.stringify([event.user, event.session]);
    const events = sessions.get(key) ?? [];
    events.push(event);
    sessions.set(key, events);
  }
  const counts = [0, 0, 0, 0];
  for (const events of sessions.values()) {
    let nextStage = 0;
    let previousTimestamp = -Infinity;
    for (const event of events.sort((left, right) => left.timestamp - right.timestamp)) {
      if (event.name === stages[nextStage] && event.timestamp > previousTimestamp) {
        counts[nextStage]++;
        previousTimestamp = event.timestamp;
        nextStage++;
      }
    }
  }
  return { checkout_sessions: counts[0], shipping_sessions: counts[1], payment_sessions: counts[2], purchase_sessions: counts[3] };
}

async function main() {
  loadEnvConfig(process.cwd(), true);
  const config = readBigQueryConfig();
  const client = createBigQueryClient(config);
  const rows = fixtures.map(event => `SELECT '${event.user}' AS user_pseudo_id, ${event.session ?? "CAST(NULL AS INT64)"} AS session_id,
    '${event.name}' AS event_name, ${event.timestamp} AS event_timestamp, '${event.date}' AS event_date`);
  const events = `SELECT user_pseudo_id, session_id, event_name, event_timestamp FROM (${rows.join(" UNION ALL ")}) fixture
    WHERE event_date BETWEEN '20201201' AND '20201231' AND user_pseudo_id != ''`;
  // Developer-only constant SELECT fixture. Production tools still require the
  // public dataset and bounded scans; this does not widen execution policy.
  const query = orderedCheckoutSql(events);
  const [job] = await client.createQueryJob({ query, location: config.location, maximumBytesBilled: config.maximumBytesBilled,
    useLegacySql: false, jobTimeoutMs: 30_000 });
  const [results] = await job.getQueryResults({ autoPaginate: false, maxResults: 1, timeoutMs: 30_000 });
  const expected = expectedCounts();
  assert.deepEqual(expected, { checkout_sessions: 6, shipping_sessions: 4, payment_sessions: 4, purchase_sessions: 3 });
  assert.deepEqual(results[0], expected);
  const chartCounts = "SELECT 100 AS checkout_sessions, 80 AS shipping_sessions, 60 AS payment_sessions, 30 AS purchase_sessions";
  const zeroCounts = "SELECT 100 AS checkout_sessions, 0 AS shipping_sessions, 0 AS payment_sessions, 0 AS purchase_sessions";
  for (const fixture of [
    {
      query: checkoutStageRowsSql(chartCounts),
      expected: [
        { stage_order: 1, stage: "Started checkout", sessions: 100 },
        { stage_order: 2, stage: "Added shipping details", sessions: 80 },
        { stage_order: 3, stage: "Added payment details", sessions: 60 },
        { stage_order: 4, stage: "Recorded purchase", sessions: 30 },
      ],
    },
    {
      query: checkoutTransitionRowsSql(chartCounts),
      expected: [
        { transition_order: 1, transition: "Checkout to shipping details", preceding_sessions: 100, next_sessions: 80, progression_rate: 0.8, non_progression_rate: 0.2 },
        { transition_order: 2, transition: "Shipping details to payment details", preceding_sessions: 80, next_sessions: 60, progression_rate: 0.75, non_progression_rate: 0.25 },
        { transition_order: 3, transition: "Payment details to recorded purchase", preceding_sessions: 60, next_sessions: 30, progression_rate: 0.5, non_progression_rate: 0.5 },
      ],
    },
    {
      query: checkoutTransitionRowsSql(zeroCounts),
      expected: [
        { transition_order: 1, transition: "Checkout to shipping details", preceding_sessions: 100, next_sessions: 0, progression_rate: 0, non_progression_rate: 1 },
        { transition_order: 2, transition: "Shipping details to payment details", preceding_sessions: 0, next_sessions: 0, progression_rate: null, non_progression_rate: null },
        { transition_order: 3, transition: "Payment details to recorded purchase", preceding_sessions: 0, next_sessions: 0, progression_rate: null, non_progression_rate: null },
      ],
    },
  ]) {
    const [chartJob] = await client.createQueryJob({
      query: fixture.query, location: config.location, maximumBytesBilled: config.maximumBytesBilled,
      useLegacySql: false, jobTimeoutMs: 30_000,
    });
    const [chartRows] = await chartJob.getQueryResults({ autoPaginate: false, maxResults: 10, timeoutMs: 30_000 });
    assert.deepEqual(chartRows, fixture.expected);
  }
  console.log("BigQuery checkout fixtures match the independent sequence oracle.", { jobId: job.id, counts: expected });
}

main().catch(() => {
  console.error("Checkout fixture verification failed.");
  process.exitCode = 1;
});
