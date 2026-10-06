# HockeyStack Analyst

Initial Next.js App Router and TypeScript scaffold. Application behavior is not implemented yet.

## Local development

Use Node.js 22 or newer and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000. The home page displays a static placeholder.

No API keys or Google credentials are needed for the scaffold.

## Commands

- `npm run dev`: start the development server.
- `npm run lint`: run ESLint.
- `npm run typecheck`: check TypeScript types.
- `npm run build`: create a production build.
- `npm start`: serve a production build.

## Structure

```text
src/
  app/                 Page shell, layout, styles; future HTTP route handlers
  features/chat/       Static client component; future chat UI and browser state
  server/
    analysis/          Future conversational analysis orchestration
    agent/             Future domain-independent agent runner
    data/              Future query service, SQL policies, and dataset guide
    adapters/          Future LLM and BigQuery integrations
    config/            Future server configuration and dependency wiring
  shared/              Future browser-safe contracts and validation schemas
```

Empty directories contain `.gitkeep` placeholders. Services, API endpoints, agent execution, queries, and persistence are not implemented.

