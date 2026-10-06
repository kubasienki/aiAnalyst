# HockeyStack Analyst

Next.js App Router and TypeScript application with an initial chat UI.

## Local development

Use Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000. Try an example question or type a message. Enter sends; Shift + Enter adds a line. New conversation clears history and the draft.

This is a UI preview: the analysis API is not connected and responses explicitly say so. No API keys or Google credentials are needed. The latest 20 message pairs are saved in this browser; storage failures leave the conversation usable in memory.

## Commands

- `npm run dev`: start the development server.
- `npm run lint`: run ESLint.
- `npm run typecheck`: check TypeScript types.
- `npm test`: run deterministic data-layer tests with fake BigQuery dependencies.
- `npm run build`: create a production build.
- `npm start`: serve a production build.
- `npm run bigquery:check`: dry-run a fixed one-day GA4 query to check access.
- `npm run bigquery:check -- --execute`: run that query and display its aggregate.
- `npm run bigquery:verify`: opt-in live reference checks through the guarded query service.

## BigQuery setup

The server uses Google's official BigQuery SDK and Application Default Credentials (ADC). The chat remains a UI preview; the connection check is a separate command. No database copy is required: Google's public project hosts the data, and your project runs query jobs.

1. Select or create a [Google Cloud project](https://console.cloud.google.com/projectselector2/home/dashboard) and [enable the BigQuery API](https://console.cloud.google.com/apis/library/bigquery.googleapis.com) in it. The query identity needs `bigquery.jobs.create`, for example through the BigQuery Job User role on that project. See [Google's prerequisites](https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset).
2. Install the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install), then sign in for application credentials:

   ```sh
   gcloud auth application-default login
   ```

3. Copy `.env.example` to `.env.local` and set `GOOGLE_CLOUD_PROJECT` to your project ID. Keep `BIGQUERY_LOCATION=US` for this dataset. Optionally set the credential quota project, using the same ID:

   ```sh
   gcloud auth application-default set-quota-project YOUR_PROJECT_ID
   ```

4. Verify access:

   ```sh
   npm run bigquery:check
   npm run bigquery:check -- --execute
   ```

The first command validates the query and reports estimated processing without executing it. The second fetches purchase-event count and purchase revenue in USD for 1 December 2020. It applies the configured billed-byte ceiling (1 GiB by default). This verifies connectivity; it does not establish all analytical definitions. See [dry runs and cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs).

ADC login is distinct from `gcloud auth login`: the SDK needs application credentials. Keep credential files outside the repository; `.env.local` is ignored. For a deployed Google Cloud workload, prefer an attached service account. See [BigQuery authentication](https://docs.cloud.google.com/bigquery/docs/authentication).

Common setup errors: missing credentials require ADC login; a disabled API must be enabled in the query project; access denied requires checking query-job permissions and the configured project; location errors require `US` for this sample.

## Data layer

`createDataLayer()` composes the SQL policy, query service, and BigQuery adapter. Call the returned function with `{ sql }` and an execution context created by `createExecutionContext()`. Reuse that context across an investigation: it carries cancellation, an absolute two-minute deadline, four query attempts, and a shared 1 MiB result budget. Rejected and repaired queries consume attempts. There are no automatic application retries.

The service validates SQL, dry-runs it, checks the configured processing ceiling, executes it, retrieves bounded pages, and returns an `ok` result or a typed failure. Successful evidence contains executed SQL, a stable result ID, columns/rows, job statistics, truncation, duration, and the semantic-guide version. It is ready for later conversation persistence; this milestone does not store it.

Supported SQL includes a single GoogleSQL `SELECT`, nonrecursive CTEs, subqueries, joins, item/parameter `UNNEST`, aggregates, grouping, ordering, and supported set-operation branches. Only fully qualified sample event tables are permitted. Each wildcard scan needs literal `_TABLE_SUFFIX` equality, `BETWEEN`, or paired inclusive bounds in its own query scope. Required bounds cannot be hidden beneath `OR` or `NOT`. When other table/derived sources share a scope, qualify the suffix with that wildcard source's unique alias. Dates must be real calendar dates within November 2020–January 2021.

Use explicit projections: `COUNT(*)` is permitted, but `SELECT *` and `alias.*` are rejected. Functions use an explicit allowlist in `sql-policy.ts`; unknown functions, qualified routines, window functions, recursive queries, decorators, scripts, writes, and exports are outside the initial subset. Parse errors fail closed. The executed SQL is the validated original, not a rewritten statement.

Results contain at most 200 rows and 256 KiB of UTF-8 JSON for columns/rows per query. One additional row detects row truncation; pagination is explicit. An individually oversized row fails with `result_size`. Byte omissions are disclosed separately from row omissions. These limits do not reduce warehouse scan cost. Exact decimals and unsafe-sized integers are strings; temporal values are strings, nested arrays/records remain JSON, and null values remain null.

Cancellation stops application polling and requests best-effort job cancellation, including a job created after submission outlives the caller's deadline. The SDK request itself may remain pending; cancellation is not a guarantee that Google stopped processing.

The semantic guide supplies metric definitions and aggregation cautions; it does not mechanically enforce calculations. Purchase events are not deduplicated orders. Event and item revenue differ in the obfuscated sample. Session conversion, acquisition interpretation, and ordered funnels require further verification.

Run `npm run bigquery:verify` after configuring credentials. It executes four reference queries and three independently structured cross-checks through the same service, verifying December revenue, device totals, users, and January product results. It uses BigQuery and is deliberately separate from `npm test`. Default caching is enabled; this command is a correctness check, not a performance benchmark.

## Structure

```text
src/
  app/                 Page shell, layout, styles; future HTTP route handlers
  features/chat/       Chat components, useChat state hook, browser storage
  server/
    analysis/          Future conversational analysis orchestration
    agent/             Future domain-independent agent runner
    data/              Query service, SQL policy, semantic guide, execution context
    adapters/          BigQuery client, job gateway, and result normalization
    config/            Validated configuration and data-layer composition
  shared/              Future browser-safe contracts and validation schemas
scripts/               BigQuery connection and live data-layer checks
```

`ChatApp` composes presentation components. `useChat` owns conversation updates, while `storage.ts` owns browser persistence and validates restored messages. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

The query-service, BigQuery, and configuration entrypoints are server-only. CLI checks use the React server condition outside Next.js; Vitest resolves the server-only marker to its empty server implementation. Configuration is loaded only when the data layer is created, so the UI builds without Google credentials. Chat APIs, agent execution, conversation persistence, charts, and streamed progress are not implemented yet.
