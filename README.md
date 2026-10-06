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
- `npm run openrouter:check`: opt-in live tool call and continuation with a fixed local result (two billable model requests; no BigQuery access).

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

Execution deadlines use a shared abort-aware waiting utility that checks wall-clock expiry on success and failure and schedules long deadlines in bounded timer chunks. Cancellation stops application polling and requests best-effort job cancellation, including a job created after submission outlives the caller's deadline. The SDK request itself may remain pending; cancellation is not a guarantee that Google stopped processing.

Missing or malformed warehouse statistics fail explicitly; unknown processing, billing, and cache metadata are never replaced with zero or false. Query diagnostics report safe categories, operation phases, elapsed milliseconds, and validated job identifiers. Failed best-effort query or response-stream cleanup is reported without masking the primary outcome.

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
    agent/             Model/tool contracts, registration, bounded attempt runner
    conversations/     Conversation/run/event contracts and repository interface
    context/           History reconstruction, context selection, projection, budgets
    contracts/         Shared server JSON value contract
    data/              Query service, SQL policy, semantic guide, execution context
    adapters/          OpenRouter, BigQuery, and SQLite persistence adapters
    config/            Server configuration and dependency composition
  shared/              Browser-safe chat contracts and input validation
scripts/               BigQuery and OpenRouter live connection checks
```

`ChatApp` composes presentation components. `useChat` owns conversation updates, while `storage.ts` owns browser persistence and validates restored messages. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

The chat service owns the server prompt and depends on a `ChatModel` interface. Its OpenRouter adapter owns HTTP requests, response validation, timeouts, and provider error mapping. Failures log only selected server diagnostics: category, configured model, HTTP status, a validated request ID when available, and numeric completion error codes. Raw bodies, credentials, and conversation contents are not logged. `config/chat.ts` constructs them; the route validates browser input and maps application errors to HTTP responses. This keeps the provider separate from the later analysis workflow.

The query-service, chat, adapters, and configuration entrypoints are server-only. CLI checks use the React server condition outside Next.js; Vitest resolves the server-only marker to its empty server implementation. Configuration is loaded on demand, so builds need no credentials. The bounded agent runner is implemented separately; analysis tool handlers, chat integration, conversation endpoints, charts, and streaming remain pending.

## Conversation persistence foundation

The persistence repository is implemented separately from the current browser-only chat. It can store conversations, execution attempts, ordered assistant/tool events, and query evidence, but the chat endpoint does not call it yet. The existing chat endpoint still uses the text-only adapter; the tool-capable adapter is available separately for the bounded runner.

`createConversationRepository()` in `server/config/persistence.ts` explicitly opens a repository using `SQLITE_DATABASE_PATH` (default `.data/hockeystack.sqlite`). Importing modules does not open a connection. Call `close()` when its owning application or script finishes. Tests use temporary on-disk databases and verify closing/reopening without losing history.

SQLite uses Drizzle and better-sqlite3 with foreign keys, WAL, and a five-second busy timeout. Writes reserve the writer lock with immediate transactions; history snapshots use deferred read transactions. The driver waits synchronously during lock contention, so the busy timeout can block the Node event loop and does not bound total operation duration. Tables and indexes are initialized with `CREATE ... IF NOT EXISTS`; there are no versioned migrations or automatic upgrades. An incompatible development database requires an explicit manual reset after closing connections. Initialization never deletes existing conversations. Keep database files, WAL/SHM files, and journals out of Git, including when configuring a custom path.

Repository operations atomically begin submissions, enforce one active run per conversation, record tool results with referenced evidence, and finalize outcomes. Reusing a client submission ID returns its original run only when input matches. Explicit retries link to a failed/cancelled/interrupted run and reuse the original user-message event. Terminal-tool acknowledgments and outcomes are saved together; unfinished calls remain in failed/interrupted history for later context handling. Expiry reconciliation is explicit and never resumes tool execution.

Stored JSON is validated at write/read boundaries. While an assistant tool batch is pending, only its unresolved results or failure finalization may follow; assistant messages and context notes are rejected atomically. Query rows are stored once in evidence records, preserving numeric strings, nulls, and truncation metadata; events contain references rather than copies. Scope and assumptions attached to evidence are analyst declarations, not proof that SQL implements those definitions. The context builder reconstructs valid model messages and checks which complete requests fit; context compaction and charts are deferred.

The assistant contract and SQLite repository support explicit `providerReplay` data: originating model, optional provider/endpoint identity, optional plaintext `reasoning`, and structured `reasoningDetails` blocks. Persistence preserves block order, fields, signatures, and encrypted content without the former 16 KiB field cap. This is server-owned protocol data, separate from evidence and display messages. The tool-capable OpenRouter adapter captures and replays it, mapping `reasoning_details` without truncating blocks. Basic chat still returns text only. The runner preserves reasoning internally; the future display projection must keep it out of browser responses. Runner diagnostics exclude reasoning and conversation contents.

## Tool-capable model boundary

`createAgentModel()` in `server/config/agent-model.ts` constructs an `AgentModel` on demand. Each `complete()` call sends one raw HTTP request. The caller supplies model messages, tool descriptions, required/none/specific tool selection, an output-token ceiling, an abort signal, and an absolute run deadline in Unix milliseconds. The adapter neither executes tools nor reads conversation storage. It can be supplied to the bounded runner; `/api/chat` does not use it yet.

`protocol.ts` owns OpenRouter message mapping and runtime validation. It checks that all assistant tool calls have exactly one matching result before continuation, sends tool definitions on every request, and serializes tool results as JSON strings. Tool-call argument strings remain unchanged, including malformed JSON; unknown tool names and valid unexpected batches are returned for the runner to handle. Invalid envelopes, incomplete replies, filtered replies, and recognized context overflow produce typed `ModelError` failures. A normal text response remains representable even when tools were required, so the runner can provide bounded corrective feedback.

Reasoning capture records both requested and resolved model identity. Continuations prefer nonempty structured reasoning blocks over duplicate plaintext; stored fields remain available unchanged. Continuations pin the resolved model instead of reusing a router alias. Cross-model replay, conflicting resolved models, and conflicting provider origins fail before HTTP. When a provider identity is available, replay restricts routing to that provider and disables fallback. When it is absent, identical endpoint routing cannot be guaranteed. Choosing which older reasoning to replay belongs to context selection; this adapter does not compact history.

The shared transport caps each request at 60 seconds or the remaining run deadline, whichever is shorter, including response-body reading. Explicit clock checks after receiving headers, reading the body, and normalizing the response enforce these budgets even when the event loop delays abort timers. Cancellation stops waiting and disposes response streams, including responses arriving late from a custom transport. `OPENROUTER_MAX_RESPONSE_BYTES` limits the complete UTF-8 response body, including reasoning (default 2 MiB). Oversized bodies fail rather than being truncated. There are no automatic retries. Agent routing requires tool parameters to be supported and disables parallel tool calls. Usage exposes reported input, output, cached-input, and reasoning tokens when available; this does not guarantee a cache hit. Failure diagnostics include elapsed milliseconds and deliberately exclude prompts, arguments, reasoning, raw errors, and bodies.

Run `npm run openrouter:check` with server credentials to verify a harmless tool request and continuation against the configured model. The script validates the requested call, supplies `{ "ok": true }` locally, replays returned reasoning, and requests a final text response. It prints only safe request IDs, usage, and whether reasoning was captured. This verifies model protocol compatibility, not analytical correctness or the future agent loop.

## Context construction

`createContext()` in `server/config/context.ts` composes a synchronous context builder and the OpenRouter request measurer. The conversation service will supply a repository `loadHistory()` snapshot, the active target run ID, prepared instruction strings, and request settings (tools, selection, output ceiling, deadline, and abort signal). Call the builder to get model messages, included event/evidence IDs, excluded incomplete interactions, and measurement metadata. This foundation is separate from the current browser chat endpoint.

Reconstruction validates referenced evidence ownership against the result event’s conversation and run, run/event ownership, user-message and retry references, attempt order, terminal outcomes, and call/result pairing. Each assistant call batch and every matching result forms one interaction. Selection keeps every complete interaction. Incomplete batches from failed, cancelled, or interrupted attempts are omitted together and reported; incomplete active batches fail explicitly. Stored history remains unchanged. Retries place the original user question at the retry position without inserting another stored user event.

Projection resolves selected evidence references into complete bounded results with SQL, rows, columns, semantic snapshot, declared scope, assumptions, and truncation metadata. Only results actually supplied enter `includedEvidenceIds`; an unavailable-result reference exposes no rows. `projectEvidence()` is shared with future live tool delivery. Terminal tool-result projections include the saved acknowledgment and validated outcome, so accepted answers and clarification choices survive minimal acknowledgments. Failed attempts include application status without raw diagnostic text.

All included assistant reasoning and original argument strings remain unchanged. The measurer uses the adapter's existing serialization and therefore applies the same model/provider compatibility checks and resolved-model pinning. Context overflow never truncates reasoning, rows, or old turns. A `ContextError` identifies invalid history, missing evidence, incompatible replay, invalid configuration, or context overflow.

`AGENT_CONTEXT_WINDOW_TOKENS` defaults to a local allowance of 65,536. Measurement reserves the request's output ceiling (normally 4,096) and another 2,048 safety tokens. The fallback estimator counts one estimated input token per UTF-8 byte of the complete encoded provider request, including instructions, tools, reasoning, routing, and JSON escaping. Metadata separates bytes and estimated tokens and identifies the estimator. It is deliberately conservative, not an exact tokenizer or a guaranteed upper bound. Verify the allowance against provider capacity when changing models; this stage does not discover capacity automatically.

`measureContextRequest()` can also preflight each runner continuation. Future compaction belongs in selection: it can replace older interactions with summaries that reference their covered events, while keeping original storage and evidence provenance. No compaction framework or summary persistence is implemented. The context builder performs no database writes or external requests and is not a browser-display projection.

## Bounded agent runner

`createAgentRunner({ model, preflight, reportFailure })` in `server/agent/runner.ts` executes one sequential attempt. Supply reconstructed messages, registered tools, application-owned state, an absolute deadline, a cancellation signal, and an awaited checkpoint callback. `preflight` uses `measureContextRequest()` with the configured measurer and budget; it checks the complete prospective request before each model call. No agent framework or automatic retries are used.

`registerTool()` generates the advertised JSON schema from a Zod argument schema and validates arguments before invoking the handler. Tools return continuing results, safe recoverable errors, or validated domain terminal outcomes. Handlers own domain validation and query budgets; the runner owns dispatch and the model-call allowance. Dynamic availability hides exhausted capabilities and is checked again before dispatch. The default is six model requests with 4,096 output tokens each; the final request offers terminal actions only. Unexpected batches execute nothing and receive matching corrective results. Repeated failed actions receive feedback without another execution. State-dependent failures become eligible again after a successful continuing tool result is checkpointed; deterministic failures declare `repeatPolicy: "unchanged_arguments"` and remain blocked. Argument validation uses this deterministic policy. Successful actions may be repeated.

Checkpoints store assistant replies before dispatch, paired tool results before continuation, and terminal acknowledgments/outcomes atomically before success. Text-only replies are followed by a durable application `context_note`, reconstructed as system context rather than a fabricated user turn. The runner forwards optional typed persistence artifacts without interpreting evidence. Tools can preflight a prospective paired result through `checkContinuation()` and choose a compact failure plus a full-evidence artifact when needed; the runner never truncates results or reasoning.

The caller owns the deadline and initial cancellation signal. The runner derives a shared abort signal for model/tool work, stops waiting for uncooperative operations, consumes late rejections, and checks the clock after awaits. Started persistence checkpoints finish before returning; a successful terminal checkpoint is the commit point and remains successful if cancellation or deadline expiry occurs during its write. Other checkpoint failures stop execution. Checkpoint adapters must complete or reject started writes; an arbitrary stalled callback is outside the runner’s execution bound. Diagnostics retain originating model, context, and checkpoint categories alongside phases, counters, and duration, never raw errors or model contents.

The conversation application service still needs to connect repository operations to checkpoints and finalize failed/cancelled attempts. Actual SQL, clarification, and answer handlers also remain to be connected. `/api/chat` continues to use the basic text-only service. Fake-model tests cover orchestration without cloud credentials or live API requests.
