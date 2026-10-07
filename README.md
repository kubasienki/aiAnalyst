# Analyst

Next.js App Router analytics assistant using a bounded agent loop, OpenRouter and guarded BigQuery queries.

See the [C4 architecture documentation](docs/architecture/README.md) for system context, containers, components, code relationships, runtime flows, persistence, and deployment requirements.

## Local development

Use Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000. Try an example question or type a message. Enter sends; Shift + Enter adds a line. New conversation starts a separate server conversation.

For analysis, configure `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `GOOGLE_CLOUD_PROJECT`, and Google Application Default Credentials. The OpenRouter key and warehouse credentials stay on the server. See the [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) for keys and model IDs.

Each turn runs as a bounded analytical attempt and persists its question, tool activity, evidence, and accepted outcome in SQLite. The API streams only coarse progress and a terminal answer, clarification, or safe failure; provider reasoning and intermediate tool records stay on the server. A conversation revision prevents stale tabs from submitting unseen context, and a stable submission ID makes reconnects idempotent. Browser history is a server snapshot. A small per-tab pending record lets reload reconcile uncertain delivery before offering a resend. See [the conversation decision record](docs/conversation-service-and-chat.md) for request and recovery behavior.

New answers save compact analytical context, evidence-linked findings and useful open questions inside their accepted outcome. A diagnostic answer cannot finish early with a necessary question that can still be investigated; execution limits or a specific obstacle permit supported partial findings. Prose leads with the conclusion, while expandable analysis details keep assumptions and evidence references secondary. See [the investigation quality decisions](docs/investigation-quality.md) for boundaries, limitations and conversational evaluation.

Configure `SQLITE_DATABASE_PATH` to keep the SQLite database outside Git. This local assessment has no accounts or per-user access control; do not expose it to untrusted users.

## Commands

- `npm run dev`: start the development server.
- `npm run lint`: run ESLint.
- `npm run typecheck`: check TypeScript types.
- `npm test`: run deterministic data, agent, conversation, and browser state tests with fake external dependencies.
- `npm run build`: create a production build.
- `npm start`: serve a production build.
- `npm run bigquery:check`: dry-run a fixed one-day GA4 query to check access.
- `npm run bigquery:check -- --execute`: run that query and display its aggregate.
- `npm run bigquery:verify`: opt-in live reference checks through the guarded query service.
- `npm run bigquery:verify-funnel`: opt-in synthetic fixtures for ordered checkout-stage handling.
- `npm run openrouter:check`: opt-in live tool call and continuation with a fixed local result (two billable model requests; no BigQuery access).
- `npm run analyst:check`: opt-in real analyst loop using OpenRouter, guarded BigQuery and temporary SQLite; adds `-- --evaluate` for analytical evaluation conversations and per-case review criteria. See [analytical quality](docs/analytical-quality.md) for the review procedure.

The analyst defines common GA4 metrics in a compact system prompt and has `inspect_dataset(topic)` for less-common schema details, observed event tags and parameter keys. That lookup uses a versioned local catalog, so it costs model context/request capacity but reads no BigQuery data. The catalog is partial discovery guidance, never an allowlist: if a question needs an unlisted key, the analyst can discover it through a narrowly bounded query via the same `run_sql` tool. The analyst uses `run_sql({ intent, sql })` for read-only warehouse queries and should project/aggregate only what the current analysis needs. BigQuery dry-run/maximum-byte limits guard scan cost; short SQL output alone does not guarantee a cheap scan.

## BigQuery setup

The server uses Google's official BigQuery SDK and Application Default Credentials (ADC). Analysis invokes the guarded query service; the connection check remains a separate command. No database copy is required: Google's public project hosts the data, and your project runs query jobs.

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

The service validates SQL, dry-runs it, checks the configured processing ceiling, executes it, retrieves bounded pages, and returns an `ok` result or a typed failure. Successful evidence contains executed SQL, a stable result ID, columns/rows, job statistics, truncation, duration, and the semantic-guide version. The query service does not persist it itself; the conversation service stores it with the corresponding tool-result checkpoint.

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
  app/                 Page shell, layout, styles, conversation and run API routes
  features/chat/       Chat components, useChat state hook, browser storage
  features/charts/     Recharts rendering, formatting, tooltips and data tables
  server/
    analysis/          Analyst tool argument schemas and outcomes
    agent/             Model/tool contracts, registration, bounded attempt runner
    charts/            Evidence validation and selected chart data projection
    conversations/     Conversation workflow, display projection and repository interface
    context/           History reconstruction, context selection, projection, budgets
    contracts/         Shared server JSON value contract
    data/              Query service, SQL policy, semantic guide, execution context
    adapters/          OpenRouter, BigQuery, and SQLite persistence adapters
    config/            Server configuration and dependency composition
  shared/              Browser-safe conversation, answer and chart contracts
scripts/               BigQuery and OpenRouter live connection checks
```

`ChatApp` composes presentation components. `ChatController` owns one tab’s request identities, reconciliation and polling; `chat-api.ts` validates JSON and decodes SSE; `storage.ts` validates browser recovery records. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

The conversation application service owns submission admission, run lifecycle, checkpoints, and safe display projection. `createAnalysisService()` owns the analytical tool state and receives reconstructed context. The bounded runner owns model/action iteration; adapters own OpenRouter, BigQuery, and SQLite details. Routes map application outcomes to HTTP and SSE without carrying workflow rules. See the implementation decision record for synchronization, retry, and failure details.

Conversation routes are Node-only and open repositories explicitly per request. They close connections after the stream and execution settle. Configuration loads on demand, so builds need no provider credentials. Browser projections exclude assistant tool calls, reasoning, context notes, SQL, and raw query payloads. Accepted charts expose only their selected columns and values.

## Conversation persistence and execution

The conversation repository stores conversations, execution attempts, ordered assistant/tool events, and query evidence. The conversation service now coordinates the repository, context builder, analysis service, and bounded runner.

`createConversationRepository()` in `server/config/persistence.ts` explicitly opens a repository using `SQLITE_DATABASE_PATH` (default `.data/analyst.sqlite`). Importing modules does not open a connection. Call `close()` when its owning application or script finishes. Tests use temporary on-disk databases and verify closing/reopening without losing history.

SQLite uses Drizzle and better-sqlite3 with foreign keys, WAL, and a five-second busy timeout. Writes reserve the writer lock with immediate transactions; history snapshots use deferred read transactions. The driver waits synchronously during lock contention, so the busy timeout can block the Node event loop and does not bound total operation duration. Tables and indexes are initialized with `CREATE ... IF NOT EXISTS`; there are no versioned migrations or automatic upgrades. An incompatible development database requires an explicit manual reset after closing connections. Initialization never deletes existing conversations. Keep database files, WAL/SHM files, and journals out of Git, including when configuring a custom path.

Repository operations atomically begin submissions, enforce one active run per conversation, record tool results with referenced evidence, and finalize outcomes. Reusing a client submission ID returns its original run only when input matches. Explicit retries link to a failed/cancelled/interrupted run and reuse the original user-message event. Terminal-tool acknowledgments and outcomes are saved together; unfinished calls remain in failed/interrupted history for later context handling. Expiry reconciliation is explicit and never resumes tool execution.

Stored JSON is validated at write/read boundaries. While an assistant tool batch is pending, only its unresolved results or failure finalization may follow; assistant messages and context notes are rejected atomically. Query rows are stored once in evidence records, preserving numeric strings, nulls, and truncation metadata; events contain references rather than copies. Scope and assumptions attached to evidence are analyst declarations, not proof that SQL implements those definitions. The context builder reconstructs valid model messages and checks which complete requests fit; context compaction is deferred. [Answer charts](docs/answer-charts.md) reference saved evidence, validate before acceptance, and render selected columns through Recharts without copying values through the model.

The assistant contract and SQLite repository support explicit `providerReplay` data: originating model, optional provider/endpoint identity, optional plaintext `reasoning`, and structured `reasoningDetails` blocks. Persistence preserves block order, fields, signatures, and encrypted content without the former 16 KiB field cap. This is server-owned protocol data, separate from evidence and display messages. The tool-capable OpenRouter adapter captures and replays it, mapping `reasoning_details` without truncating blocks. The conversation display projection excludes reasoning. The runner preserves it internally; diagnostics exclude reasoning and conversation contents. Runner diagnostics exclude reasoning and conversation contents.

## Tool-capable model boundary

`createAgentModel()` in `server/config/agent-model.ts` constructs an `AgentModel` on demand. Each `complete()` call sends one raw HTTP request. The caller supplies model messages, tool descriptions, required/none/specific tool selection, an output-token ceiling, an abort signal, and an absolute run deadline in Unix milliseconds. The adapter neither executes tools nor reads conversation storage. The configured analysis service supplies it to the bounded runner.

`protocol.ts` owns OpenRouter message mapping and runtime validation. It checks that all assistant tool calls have exactly one matching result before continuation, sends tool definitions on every request, and serializes tool results as JSON strings. Tool-call argument strings remain unchanged, including malformed JSON; unknown tool names and valid unexpected batches are returned for the runner to handle. Invalid envelopes, incomplete replies, filtered replies, and recognized context overflow produce typed `ModelError` failures. A normal text response remains representable even when tools were required, so the runner can provide bounded corrective feedback.

Reasoning capture records both requested and resolved model identity. Continuations prefer nonempty structured reasoning blocks over duplicate plaintext; stored fields remain available unchanged. Continuations pin the resolved model instead of reusing a router alias. Cross-model replay, conflicting resolved models, and conflicting provider origins fail before HTTP. When a provider identity is available, replay restricts routing to that provider and disables fallback. When it is absent, identical endpoint routing cannot be guaranteed. Choosing which older reasoning to replay belongs to context selection; this adapter does not compact history.

The shared transport caps each request at 60 seconds or the remaining run deadline, whichever is shorter, including response-body reading. Explicit clock checks after receiving headers, reading the body, and normalizing the response enforce these budgets even when the event loop delays abort timers. Cancellation stops waiting and disposes response streams, including responses arriving late from a custom transport. `OPENROUTER_MAX_RESPONSE_BYTES` limits the complete UTF-8 response body, including reasoning (default 2 MiB). Oversized bodies fail rather than being truncated. There are no automatic retries. Agent routing requires tool parameters to be supported and disables parallel tool calls. Usage exposes reported input, output, cached-input, and reasoning tokens when available; this does not guarantee a cache hit. Failure diagnostics include elapsed milliseconds and deliberately exclude prompts, arguments, reasoning, raw errors, and bodies.

Run `npm run openrouter:check` with server credentials to verify a harmless tool request and continuation against the configured model. The script validates the requested call, supplies `{ "ok": true }` locally, replays returned reasoning, and requests a final text response. It prints only safe request IDs, usage, and whether reasoning was captured. This verifies model protocol compatibility, not analytical correctness.

## Context construction

`createContext()` in `server/config/context.ts` composes a synchronous context builder and the OpenRouter request measurer. The conversation service supplies a repository `loadHistory()` snapshot, the active target run ID, prepared instruction strings, and request settings (tools, selection, output ceiling, deadline, and abort signal). Call the builder to get model messages, included event/evidence IDs, excluded incomplete interactions, and measurement metadata. This context is used for each new conversational analysis attempt.

Reconstruction validates referenced evidence ownership against the result event’s conversation and run, run/event ownership, user-message and retry references, attempt order, terminal outcomes, and call/result pairing. Each assistant call batch and every matching result forms one interaction. Selection keeps every complete interaction. Incomplete batches from failed, cancelled, or interrupted attempts are omitted together and reported; incomplete active batches fail explicitly. Stored history remains unchanged. Retries place the original user question at the retry position without inserting another stored user event.

Projection resolves selected evidence references into complete bounded results with SQL, rows, columns, semantic snapshot, declared scope, assumptions, and truncation metadata. Only results actually supplied enter `includedEvidenceIds`; an unavailable-result reference exposes no rows. `projectEvidence()` is shared with live tool delivery. Terminal tool-result projections include the saved acknowledgment and validated outcome, so accepted answers and clarification choices survive minimal acknowledgments. Failed attempts include application status without raw diagnostic text.

All included assistant reasoning and original argument strings remain unchanged. The measurer uses the adapter's existing serialization and therefore applies the same model/provider compatibility checks and resolved-model pinning. Context overflow never truncates reasoning, rows, or old turns. A `ContextError` identifies invalid history, missing evidence, incompatible replay, invalid configuration, or context overflow.

`AGENT_CONTEXT_WINDOW_TOKENS` defaults to a local allowance of 1,000,000. Measurement reserves the request's output ceiling (normally 4,096) and another 2,048 safety tokens. The fallback estimator counts one estimated input token per UTF-8 byte of the complete encoded provider request, including instructions, tools, reasoning, routing, and JSON escaping. Metadata separates bytes and estimated tokens and identifies the estimator. It is deliberately conservative, not an exact tokenizer or a guaranteed upper bound. Verify the allowance against provider capacity when changing models; this stage does not discover capacity automatically.

`measureContextRequest()` can also preflight each runner continuation. Future compaction belongs in selection: it can replace older interactions with summaries that reference their covered events, while keeping original storage and evidence provenance. No compaction framework or summary persistence is implemented. The context builder performs no database writes or external requests and is not a browser-display projection.

## Bounded agent runner

`createAgentRunner({ model, preflight, reportFailure })` in `server/agent/runner.ts` executes one sequential attempt. Supply reconstructed messages, registered tools, application-owned state, an absolute deadline, a cancellation signal, and an awaited checkpoint callback. `preflight` uses `measureContextRequest()` with the configured measurer and budget; it checks the complete prospective request before each model call. No agent framework or automatic retries are used.

`registerTool()` generates the advertised JSON schema from a Zod argument schema and validates arguments before invoking the handler. Tools return continuing results, safe recoverable errors, or validated domain terminal outcomes. Handlers own domain validation and query budgets; the runner owns dispatch and the model-call allowance. Dynamic availability hides exhausted capabilities and is checked again before dispatch. The default is six model requests with 4,096 output tokens each; the final request offers terminal actions only. Unexpected batches execute nothing and receive matching corrective results. Repeated failed actions receive feedback without another execution. State-dependent failures become eligible again after a successful continuing tool result is checkpointed; deterministic failures declare `repeatPolicy: "unchanged_arguments"` and remain blocked. Argument validation uses this deterministic policy. Successful actions may be repeated.

Checkpoints store assistant replies before dispatch, paired tool results before continuation, and terminal acknowledgments/outcomes atomically before success. Text-only replies are followed by a durable application `context_note`, reconstructed as system context rather than a fabricated user turn. The runner forwards optional typed persistence artifacts without interpreting evidence. Tools can preflight a prospective paired result through `checkContinuation()` and choose a compact failure plus a full-evidence artifact when needed; the runner never truncates results or reasoning.

The caller owns the deadline and initial cancellation signal. The runner derives a shared abort signal for model/tool work, stops waiting for uncooperative operations, consumes late rejections, and checks the clock after awaits. Started persistence checkpoints finish before returning; a successful terminal checkpoint is the commit point and remains successful if cancellation or deadline expiry occurs during its write. Other checkpoint failures stop execution. Checkpoint adapters must complete or reject started writes; an arbitrary stalled callback is outside the runner’s execution bound. Diagnostics retain originating model, context, and checkpoint categories alongside phases, counters, and duration, never raw errors or model contents.

The conversation service connects repository operations to awaited runner checkpoints and finalizes failed, cancelled, and interrupted attempts. Conversation policies own admission, retry eligibility, and finalization decisions; the SQLite adapter evaluates them using facts read inside its transactions. The analysis recording adapter maps checkpoints and translates storage failures into agent-owned error provenance. Composition similarly translates context preflight errors, keeping the generic runner independent of conversation and context implementations.

Debug traces are best-effort and separate from mandatory analytical checkpoints. Each callback receives a cancellation signal and is awaited for at most 100 ms or the remaining execution deadline. Trace errors and late rejections cannot replace model/tool outcomes; successful tool traces follow their checkpoint, and terminal acceptance survives tracing failures. Writers must check the supplied signal before accessing a repository after asynchronous work. SQLite writes are synchronous, so this ceiling does not bound driver lock waits. Safe diagnostic reporters are protected from throwing, including during conversation recovery and chart fallback. Debugger envelopes are runtime-validated, while arbitrary payloads and malformed JSON remain inspectable; capture can be incomplete.

`createAnalysisService()` supplies the SQL, clarification, and answer tools. Fake-model tests cover orchestration without cloud credentials or live API requests.

## Conversation service and browser integration

See [the implementation decision record](docs/conversation-service-and-chat.md) for workflow ownership, API contracts, duplicate prevention, browser recovery, alternatives, and acceptance scenarios.
