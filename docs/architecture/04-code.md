# C4 level 4: selected code relationships

These views describe the implemented collaboration contracts, not an object-oriented rewrite. Mermaid class boxes marked `function`, `type`, or `factory_product` represent those code constructs. Method lists are selected rather than exhaustive; generic parameters are abbreviated in diagrams and defined in the linked source.

## Conversation orchestration

```mermaid
classDiagram
    class openConversationApplication {
        <<function>>
        creates service and repository
        returns service and close
    }
    class createConversationService {
        <<function>>
        accepts repository and prepareExecution
        returns ConversationService
    }
    class ConversationService {
        <<factory_product>>
        create()
        load(conversationId)
        submitMessage(conversationId, input)
        retry(conversationId, runId, input)
    }
    class AdmittedSubmission {
        <<type>>
        run
        created
        snapshot
        execute
    }
    class PreparedConversationExecution {
        <<type>>
        versions
        instructions
        tools
        buildContext
        analyze
    }
    class ConversationRepository {
        <<interface>>
        findSubmission(input)
        startRun(input)
        retryRun(input)
        loadHistory(conversationId)
        appendAssistant(runId, message)
        recordToolResult(runId, result, evidence)
        finishRun(runId, input)
        recordAgentTrace(runId, trace)
        interruptExpiredRuns(now, graceMs)
        close()
    }
    class openConversationRepository {
        <<function>>
        accepts databasePath and optional clock
        returns ConversationRepository
    }
    openConversationApplication ..> createConversationService : composes
    openConversationApplication ..> openConversationRepository : opens via config
    createConversationService --> ConversationRepository : injected dependency
    createConversationService --> PreparedConversationExecution : prepareExecution returns
    createConversationService ..> ConversationService : returns
    ConversationService --> AdmittedSubmission : submit and retry return
    openConversationRepository ..> ConversationRepository : implements contract
```

The HTTP bridge consumes `AdmittedSubmission`. Only a newly created run has an executor. A duplicate returns the existing snapshot without rerunning analysis. `ConversationRepository` is the application boundary; `openConversationRepository` supplies a SQLite-backed implementation. Services receive clocks and collaborators explicitly where supported; mutable analytical state belongs to one invocation.

The service supplies persistence hooks through `createAnalysisRecording`. The SQLite implementation evaluates admission and finalization through pure conversation policies inside its existing transactions. `AgentRunnerError.origin` carries safe provenance translated by those recording hooks and by `createAgentPreflight`; the generic runner does not inspect storage or context error classes.

Sources: [composition](../../src/server/config/conversations.ts), [service and admission types](../../src/server/conversations/service.ts), [repository interface](../../src/server/conversations/repository.ts), and [SQLite implementation](../../src/server/adapters/persistence/repository.ts).

## Agent and tool boundary

```mermaid
classDiagram
    class createAnalysisService {
        <<function>>
        accepts runAgent and executeQuery
        seeds visibleEvidence
        wraps checkpoint to grant evidence visibility
    }
    class AnalysisRunState {
        <<type>>
        queryExecution
        visibleEvidence
    }
    class createAgentRunner {
        <<function>>
        accepts model and preflight
        returns async runner
    }
    class AgentRunInput {
        <<type>>
        messages
        tools
        applicationContext
        signal
        deadline
        checkpoint(event)
    }
    class AgentModel {
        <<interface>>
        complete(request) Promise~ModelResponse~
    }
    class RegisteredTool {
        <<type>>
        name
        parameters
        role
        isAvailable(context)
        execute(argumentsValue, context)
    }
    class registerTool {
        <<function>>
        accepts Zod schema and handler
        creates JSON schema and validated executor
    }
    class AgentCheckpoint {
        <<union>>
        assistant
        context_note
        tool_result
        terminal
    }
    class AnalysisEvidenceArtifact {
        <<type>>
        input
        delivery
    }
    createAnalysisService --> AnalysisRunState : owns per invocation
    createAnalysisService --> createAgentRunner : supplied runner
    createAgentRunner --> AgentRunInput : receives
    createAgentRunner --> AgentModel : completes requests through
    AgentRunInput --> RegisteredTool : contains
    AgentRunInput --> AnalysisRunState : applicationContext in analyst
    registerTool ..> RegisteredTool : produces
    createAgentRunner --> RegisteredTool : sequential dispatch
    createAgentRunner --> AgentCheckpoint : awaits callback
    AgentCheckpoint --> AnalysisEvidenceArtifact : optional tool-result artifact
```

`RegisteredTool` validates unknown arguments near the boundary. Execution returns a discriminated union: continuing content, recoverable error, or terminal acknowledgment and outcome. The generic runner forwards artifacts without understanding their domain. The analysis service grants evidence visibility after persistence; the conversation service maps checkpoints to repository writes.

Model/tool trace callbacks accept an `AbortSignal`. Trace capture is best-effort and bounded to 100 ms or remaining execution time, with late failures consumed. Successful tool traces follow their mandatory checkpoint; terminal acceptance does not depend on a trace write.

Sources: [model and tool contracts](../../src/server/agent/contracts.ts), [runner input/checkpoint contracts](../../src/server/agent/runner-contracts.ts), [tool registration](../../src/server/agent/tool-registration.ts), [analysis state](../../src/server/analysis/types.ts), and [analysis service](../../src/server/analysis/service.ts).

## Guarded query boundary

```mermaid
classDiagram
    class createDataLayer {
        <<function>>
        composes configuration, gateway and query service
    }
    class createQueryService {
        <<function>>
        accepts gateway and maximumBytesBilled
        returns QueryExecutor
    }
    class QueryExecutor {
        <<function_type>>
        execute(request, context) Promise~QueryOutcome~
    }
    class ExecutionContext {
        <<type>>
        signal
        deadline
        shared mutable budget
    }
    class BigQueryGateway {
        <<type>>
        dryRun(sql)
        submit(sql, options) Promise~DataQueryJob~
    }
    class DataQueryJob {
        <<type>>
        id
        readPage(options)
        statistics()
        cancel()
    }
    class QueryOutcome {
        <<union>>
        ok true with QueryEvidence
        ok false with typed error
    }
    class QueryEvidence {
        <<type>>
        resultId
        sql
        columns and rows
        payloadBytes and truncation
        jobId and statistics
        semanticGuideVersion
    }
    createDataLayer --> createQueryService : composes
    createDataLayer --> BigQueryGateway : builds SDK adapter
    createQueryService --> BigQueryGateway : injected dependency
    createQueryService ..> QueryExecutor : returns
    QueryExecutor --> ExecutionContext : consumes shared budget
    BigQueryGateway --> DataQueryJob : submit returns
    QueryExecutor --> QueryOutcome : returns
    QueryOutcome --> QueryEvidence : success payload
```

`QueryExecutor` accepts `{ sql: unknown }`: TypeScript does not substitute for runtime SQL validation. Deadline units are absolute Unix milliseconds; byte budgets count UTF-8 JSON for columns and rows. `BigQueryGateway` and `DataQueryJob` hide SDK types. The query service returns evidence but performs no persistence; the tool-result checkpoint owns storage.

Sources: [data composition](../../src/server/config/data-layer.ts), [data contracts](../../src/server/data/types.ts), [query service](../../src/server/data/query-service.ts), and [BigQuery gateway](../../src/server/adapters/bigquery/gateway.ts).
