# Analyst

A conversational analytics app built with Next.js. It answers questions about Google's public GA4 ecommerce sample using OpenRouter and guarded BigQuery queries. Conversations and query evidence are stored in SQLite.

Assumptions, cuts, and what I would do next are in the [decision log](docs/assessment-decision-log.md).

## Run locally

Use Node.js 22 or newer.

```sh
npm install
cp .env.example .env.local
npm run dev
```

Set `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `GOOGLE_CLOUD_PROJECT` in `.env.local`. For BigQuery access, configure Google Application Default Credentials with `gcloud auth application-default login`. The source dataset is public; your Google Cloud project runs the query jobs.

Open http://localhost:3000. Set `SQLITE_DATABASE_PATH` to choose where conversation history is stored.

## Commands

- `npm run dev` — start the development server.
- `npm test` — run tests.
- `npm run lint` — run ESLint.
- `npm run typecheck` — check TypeScript types.
- `npm run build` — create a production build.
- `npm start` — serve a production build.
- `npm run bigquery:check` — check BigQuery access with a dry run.
- `npm run analyst:check` — run an opt-in live analyst check using OpenRouter and BigQuery.

Production requires `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD`. SQLite needs persistent writable storage. Set `SQLITE_DATABASE_PATH` to a file on that storage.
