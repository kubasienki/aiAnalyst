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

## Structure

```text
src/
  app/                 Page shell, layout, styles; future HTTP route handlers
  features/chat/       Chat components, useChat state hook, browser storage
  server/
    analysis/          Future conversational analysis orchestration
    agent/             Future domain-independent agent runner
    data/              Future query service, SQL policies, and dataset guide
    adapters/          Future LLM and BigQuery integrations
    config/            Future server configuration and dependency wiring
  shared/              Future browser-safe contracts and validation schemas
```

`ChatApp` composes presentation components. `useChat` owns conversation updates, while `storage.ts` owns browser persistence and validates restored messages. Feature styling stays in a CSS module. The page remains a minimal server-rendered shell.

Empty server directories contain `.gitkeep` placeholders. Services, API endpoints, agent execution, queries, charts, and streamed progress are not implemented yet. The next integration replaces the preview reply in `useChat` with a chat transport without coupling presentation components to server services.
