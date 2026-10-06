import { loadEnvConfig } from "@next/env";
import { createBigQueryClient } from "../src/server/adapters/bigquery/client";
import { readBigQueryConfig } from "../src/server/config/bigquery";

// Fixed one-day aggregate. This is a setup check, not a general SQL entrypoint.
const query = `
  SELECT
    COUNT(*) AS purchase_event_count,
    SUM(ecommerce.purchase_revenue_in_usd) AS purchase_revenue_usd
  FROM \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`
  WHERE _TABLE_SUFFIX = '20201201'
    AND event_name = 'purchase'
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute")) {
    throw new Error("Usage: npm run bigquery:check -- [--execute]");
  }

  loadEnvConfig(process.cwd(), true);
  const config = readBigQueryConfig();
  const client = createBigQueryClient(config);
  const options = {
    query,
    location: config.location,
    useLegacySql: false,
    maximumBytesBilled: config.maximumBytesBilled,
  };

  const [dryRun] = await client.createQueryJob({ ...options, dryRun: true });
  const estimatedBytes = dryRun.metadata.statistics?.totalBytesProcessed;
  if (estimatedBytes === undefined) {
    throw new Error("BigQuery did not return a processing estimate.");
  }
  console.log(`Dry run succeeded. Estimated bytes processed: ${estimatedBytes}`);
  if (BigInt(estimatedBytes) > BigInt(config.maximumBytesBilled)) {
    throw new Error("The setup query exceeds BIGQUERY_MAX_BYTES_BILLED.");
  }

  if (!args.includes("--execute")) {
    console.log("Dataset access verified by dry run. Add --execute to fetch the aggregate.");
    return;
  }

  const [job] = await client.createQueryJob(options);
  console.log(`Query job: ${job.id}`);
  const [rows] = await job.getQueryResults({ autoPaginate: false, maxResults: 1 });
  console.table(rows);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "BigQuery check failed.");
  process.exitCode = 1;
});
