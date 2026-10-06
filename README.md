# HockeyStack Analyst

Next.js App Router and TypeScript application with an OpenRouter-powered chat and a separate guarded BigQuery data layer.

## Local development

Use Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000. Try an example question or type a message. Enter sends; Shift + Enter adds a line. New conversation clears history and the draft.

For AI replies, copy `.env.example` to `.env.local` and set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to an OpenRouter model ID available to your account. Restart the development server after changing configuration. Keys stay on the server; no Google credentials are needed for chat. See the [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) for keys and model IDs.

Chat sends one non-streaming model request per turn through `POST /api/chat`. The recent conversation is included for follow-up questions. The model has no tools or dataset access yet and is instructed not to invent analytical results. Loading and retry states are shown; New conversation cancels the browser request and prevents an old reply from entering the new conversation. Provider requests have a 60-second deadline and a 2,000-token output ceiling, with no automatic retries. Incomplete or filtered replies are reported as failures rather than saved as completed answers. Sending a follow-up after a failure preserves the unanswered question; retry resends the existing conversation.

The latest 40 messages are saved in this browser; storage failures leave the conversation usable in memory. Context sent to the model is bounded to 39 messages and 64,000 characters, dropping older turns when needed. Browser history is client-supplied, not durable server conversation storage. This initial endpoint has no authentication or per-user rate limiting and is intended for local development.

## Commands

- `npm run dev`: start the development server.
- `npm run lint`: run ESLint.
- `npm run typecheck`: check TypeScript types.
- `npm test`: run deterministic data-layer and chat tests with fake external dependencies.
- `npm run build`: create a production build.
- `npm start`: serve a production build.
- `npm run bigquery:check`: dry-run a fixed one-day GA4 query to check access.
- `npm run bigquery:check -- --execute`: run that query and display its aggregate.
- `npm run bigquery:verify`: opt-in live reference checks through the guarded query service.

## BigQuery setup

The server uses Google's official BigQuery SDK and Application Default Credentials (ADC). Chat does not call BigQuery yet; the connection check is a separate command. No database copy is required: Google's public project hosts the data, and your project runs query jobs.

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

The service validates SQL, dry-runs it, checks the configured processing ceiling, executes it, retrieves bounded pages, and returns an `ok` result or a typed failure. Successful evidence contains executed SQL, a stable result ID, columns/rows, job statistics, truncation, duration, and the semantic-guide version. The query service does not persist it itself; the separate conversation repository can store it when execution is connected.

Supported SQL includes a single GoogleSQL `SELECT`, nonrecursive CTEs, subqueries, joins, item/parameter `UNNEST`, aggregates, grouping, ordering, and supported set-operation branches. Only fully qualified sample event tables are permitted. Each wildcard scan needs literal `_TABLE_SUFFIX` equality, `BETWEEN`, or paired inclusive bounds in its own query scope. Required bounds cannot be hidden beneath `OR` or `NOT`. When other table/derived sources share a scope, qualify the suffix with that wildcard source's unique alias. Dates must be real calendar dates within November 2020–January 2021.

Use explicit projections: `COUNT(*)` is permitted, but `SELECT *` and `alias.*` are rejected. Functions use an explicit allowlist in `sql-policy.ts`; unknown functions, qualified routines, window functions, recursive queries, decorators, scripts, writes, and exports are outside the initial subset. Parse errors fail closed. The executed SQL is the validated original, not a rewritten statement.

Results contain at most 200 rows and 256 KiB of UTF-8 JSON for columns/rows per query. One additional row detects row truncation; pagination is explicit. An individually oversized row fails with `result_size`. Byte omissions are disclosed separately from row omissions. These limits do not reduce warehouse scan cost. Exact decimals and unsafe-sized integers are strings; temporal values are strings, nested arrays/records remain JSON, and null values remain null.

Cancellation stops application polling and requests best-effort job cancellation, including a job created after submission outlives the caller's deadline. The SDK request itself may remain pending; cancellation is not a guarantee that Google stopped processing.

The semantic guide supplies metric definitions and aggregation cautions; it does not mechanically enforce calculations. Purchase events are not deduplicated orders. Event and item revenue differ in the obfuscated sample. Session conversion, acquisition interpretation, and ordered funnels require further verification.

Run `npm run bigquery:verify` after configuring credentials. It executes four reference queries and three independently structured cross-checks through the same service, verifying December revenue, device totals, users, and January product results. It uses BigQuery and is deliberately separate from `npm test`. Default caching is enabled; this command is a correctness check, not a performance benchmark.

## Structure

```text
src/
  app/                 Page shell, layout, styles, thin /api/chat route
  features/chat/       Chat components, useChat state hook, browser storage
  server/
    chat/              Single-turn chat service and model boundary
    analysis/          Analyst tool argument schemas and outcomes
    agent/             Model messages and tool execution contracts; runner deferred
    conversations/     Conversation/run/event contracts and repository interface
    contracts/         Shared server JSON value contract
    data/              Query service, SQL policy, semantic guide, execution context
    adapters/          OpenRouter, BigQuery, and SQLite persistence adapters
    config/            Server configuration and dependency composition
  shared/              Browser-safe chat contracts and input validation
scripts/               BigQuery connection and live data-layer checks
```

`ChatApp` composes presentation components. `useChat` owns conversation updates, while `storage.ts` owns browser persistence and validates restored messages. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

The chat service owns the server prompt and depends on a `ChatModel` interface. Its OpenRouter adapter owns HTTP requests, response validation, timeouts, and provider error mapping. Failures log only selected server diagnostics: category, configured model, HTTP status, a validated request ID when available, and numeric completion error codes. Raw bodies, credentials, and conversation contents are not logged. `config/chat.ts` constructs them; the route validates browser input and maps application errors to HTTP responses. This keeps the provider separate from the later analysis workflow.

The query-service, chat, adapters, and configuration entrypoints are server-only. CLI checks use the React server condition outside Next.js; Vitest resolves the server-only marker to its empty server implementation. Configuration is loaded on demand, so builds need no credentials. Agent execution, conversation endpoints, charts, and streaming are not implemented yet.

## Conversation persistence foundation

The persistence repository is implemented separately from the current browser-only chat. It can store conversations, execution attempts, ordered assistant/tool events, and query evidence, but the chat endpoint does not call it yet. The new agent contracts do not change the existing text-only OpenRouter integration.

`createConversationRepository()` in `server/config/persistence.ts` explicitly opens a repository using `SQLITE_DATABASE_PATH` (default `.data/hockeystack.sqlite`). Importing modules does not open a connection. Call `close()` when its owning application or script finishes. Tests use temporary on-disk databases and verify closing/reopening without losing history.

SQLite uses Drizzle and better-sqlite3 with foreign keys, WAL, and a five-second busy timeout. Tables and indexes are initialized with `CREATE ... IF NOT EXISTS`; there are no versioned migrations or automatic upgrades. An incompatible development database requires an explicit manual reset after closing connections. Initialization never deletes existing conversations. Keep database files, WAL/SHM files, and journals out of Git, including when configuring a custom path.

Repository operations atomically begin submissions, enforce one active run per conversation, record tool results with referenced evidence, and finalize outcomes. Reusing a client submission ID returns its original run only when input matches. Explicit retries link to a failed/cancelled/interrupted run and reuse the original user-message event. Terminal-tool acknowledgments and outcomes are saved together; unfinished calls remain in failed/interrupted history for later context handling. Expiry reconciliation is explicit and never resumes tool execution.

Stored JSON is validated at write/read boundaries. Query rows are stored once in evidence records, preserving numeric strings, nulls, and truncation metadata; events contain references rather than copies. Scope and assumptions attached to evidence are analyst declarations, not proof that SQL implements those definitions. The future context builder will reconstruct valid model messages and decide which evidence fits; context compaction and charts are deferred.

The assistant contract and SQLite repository support explicit `providerReplay` data: originating model, optional provider/endpoint identity, optional plaintext `reasoning`, and structured `reasoningDetails` blocks. Persistence preserves block order, fields, signatures, and encrypted content without the former 16 KiB field cap. This is server-owned protocol data, separate from evidence and display messages. The current text-only OpenRouter adapter does not capture or replay it yet; adapter integration will map OpenRouter's `reasoning_details` field and enforce overall response/context budgets without truncating required blocks. Display projection and adapter integration must exclude reasoning from browser responses and logs.
