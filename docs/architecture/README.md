# Analyst architecture

This is the architecture of the repository as inspected on 7 October 2026, including working-tree changes. It describes implemented behavior; existing implementation plans are not evidence that a feature exists. The intended audience is developers onboarding to or maintaining the application.

Analyst is a conversational analytics assistant for Google's public GA4 ecommerce sample. A React browser client submits questions to a Next.js Node server. The server reconstructs durable conversation context, runs a bounded model/tool loop through OpenRouter, executes guarded BigQuery queries, and saves evidence and accepted outcomes in SQLite. Browser answers include prose, analytical metadata, and optional evidence-derived charts.

## Reading order

| View | Question answered |
| --- | --- |
| [C4 level 1: system context](01-system-context.md) | Who uses the system and what external systems does it depend on? |
| [C4 level 2: containers](02-containers.md) | Where does code execute and where is data stored? |
| [C4 level 3: components](03-components.md) | Which modules own each responsibility? |
| [C4 level 4: code](04-code.md) | How do the central interfaces and function factories fit together? |
| [Runtime flows](05-runtime-flows.md) | How do requests, checkpoints, recovery, and cancellation interact? |
| [Data and deployment](06-data-and-deployment.md) | What persists, how does the system run, and what constrains it? |
| [Agent orchestration](07-agent-orchestration.md) | How is the analyst assembled, how are actions dispatched, and when does an attempt finish? |

## Diagram conventions

Diagrams use Mermaid inside Markdown fences. Flowcharts express C4 concepts using explicit element types, technologies, labeled relationships, and subgraph boundaries; they do not require Mermaid's experimental C4 syntax. Class diagrams show selected code relationships, sequence diagrams show temporal behavior, and the ER diagram shows storage ownership.

- **Person**: a user or operator role.
- **Software system**: Analyst or an external service.
- **Container**: an execution environment or data store. This does not imply Docker.
- **Component**: a responsibility implemented by modules within a container, not a separately deployed service.
- **Code element**: an actual interface, named type, class, or function factory. Factory products are explicitly identified as such.
- Solid arrows show communication or dependency; dashed arrows show wiring or realization where labeled. Arrow labels identify the operation and protocol where relevant.

The repository is one Next.js project. Its browser and server are distinct execution boundaries, not independently managed microservices. SQLite is an embedded store, not a database server. Model providers behind OpenRouter are represented through the OpenRouter boundary because the application has no direct provider integration.

## Sources and maintenance

Start with [the repository guide](../../README.md), [package manifest](../../package.json), [dependency composition](../../src/server/config/conversations.ts), and [shared HTTP contracts](../../src/shared/conversations.ts). Each view links the implementation that supports its claims. Configuration tables use public defaults from [`.env.example`](../../.env.example) and configuration modules; they contain no credential values or real conversation records.

Related decisions: [conversation service and chat](../conversation-service-and-chat.md), [answer charts](../answer-charts.md), [investigation quality](../investigation-quality.md), and [analytical evaluation](../analytical-quality.md). [The analytical context implementation plan](../analytical-context-implementation-plan.md) is a planning record, not an inventory of shipped features.

Update the affected views when execution boundaries, tool contracts, persistence schema, public endpoints, or budgets change. Keep element names consistent across levels and verify every source link. Level 4 deliberately focuses on the central collaboration contracts rather than reproducing every function in the repository.

The audit fixes preserve the same containers and HTTP contracts. Conversation policies now hold admission and finalization rules, application/composition adapters translate errors to agent contracts, and best-effort trace capture is distinct from mandatory checkpoints. The debugger uses shared envelope schemas and separate HTTP/presentation modules.
