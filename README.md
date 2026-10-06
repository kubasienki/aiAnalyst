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
- `npm run build`: create a production build.
- `npm start`: serve a production build.
- `npm run bigquery:check`: dry-run a fixed one-day GA4 query to check access.
- `npm run bigquery:check -- --execute`: run that query and display its aggregate.

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

## Structure

```text
src/
  app/                 Page shell, layout, styles; future HTTP route handlers
  features/chat/       Chat components, useChat state hook, browser storage
  server/
    analysis/          Future conversational analysis orchestration
    agent/             Future domain-independent agent runner
    data/              Future query service, SQL policies, and dataset guide
    adapters/          BigQuery client factory; future LLM integration
    config/            Validated BigQuery configuration; future dependency wiring
  shared/              Future browser-safe contracts and validation schemas
scripts/               Fixed BigQuery connection check
```

`ChatApp` composes presentation components. `useChat` owns conversation updates, while `storage.ts` owns browser persistence and validates restored messages. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

The BigQuery factory and configuration are server-only. The connection script uses the React server condition to import them outside Next.js. They are initialized only when requested, so the UI builds without Google credentials. General query execution, SQL validation, API endpoints, agent execution, charts, and streamed progress are not implemented yet. The next integration replaces the preview reply in `useChat` with a chat transport without coupling presentation components to server services.
