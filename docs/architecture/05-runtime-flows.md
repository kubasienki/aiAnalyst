# Runtime flows

## Message to accepted answer

```mermaid
sequenceDiagram
    actor User
    participant Browser as ChatController
    participant HTTP as Route / SSE bridge
    participant Service as Conversation service
    participant DB as SQLite repository
    participant Context as Context builder
    participant Analyst as Analysis service / runner
    participant Model as OpenRouter
    participant Tool as Registered tools
    User->>Browser: Send question
    Browser->>Browser: Save stable submission ID and pending operation
    Browser->>HTTP: POST message with expectedRevision
    HTTP->>Service: Validate and submitMessage
    Service->>DB: Reconcile expiry and look up duplicate
    Service->>Service: Prepare configured analytical dependencies
    Service->>DB: Atomically admit run and user event
    DB-->>Service: New running attempt
    HTTP-->>Browser: SSE accepted with snapshot
    HTTP->>Service: Execute with request cancellation signal
    Service->>DB: Load consistent history snapshot
    Service->>Context: Reconstruct, select, project and measure
    Context-->>Service: Model messages and included evidence IDs
    Service->>Analyst: Analyze with deadline and checkpoint callbacks
    loop Bounded sequential model requests
        Analyst->>Analyst: Preflight complete prospective request
        Analyst->>Model: Model request with available tool definitions
        Model-->>Analyst: Assistant tool call
        Analyst->>Service: Await assistant checkpoint
        Service->>DB: Save assistant event
        Analyst->>Tool: Dispatch one validated available action
        Tool-->>Analyst: Continuing result, error, or terminal outcome
        alt Continuing tool result or recoverable error
            Analyst->>Service: Await paired tool-result checkpoint
            Service->>DB: Save result and optional evidence atomically
            Analyst->>Analyst: Grant visibility to delivered evidence
        else Accepted terminal tool
            Analyst->>Service: Await terminal checkpoint
            Service->>DB: Save acknowledgment and outcome atomically
            Note over Analyst,DB: Successful terminal checkpoint is the commit point
        end
    end
    Service->>DB: Read durable history after execution
    Service->>Service: Project safe outcome and selected charts
    Service-->>HTTP: Terminal snapshot event
    HTTP-->>Browser: SSE answer, clarification, or error
    HTTP->>HTTP: Close repository after execution settles
```

The loop ends on a terminal checkpoint or failure; it does not keep requesting the model after acceptance. The default allowance is six model calls, with terminal actions only on the last call. Text-only model replies are not accepted final answers: the runner persists a corrective context note and requests a tool action while capacity remains. Unexpected call batches execute nothing and receive paired corrective results. Deterministic failed arguments remain suppressed; other failures can become eligible after a successful continuing checkpoint.

Model trace capture occurs before the model adapter returns; successful tool trace capture occurs after its checkpoint. Both are best-effort waits of at most 100 ms or remaining execution time. Failed capture cannot replace the primary outcome; a terminal commit remains successful if subsequent capture reaches the deadline. Cancelled or expired capture is skipped, late rejections are consumed, and callbacks receive a signal that forbids later repository access after cancellation. Diagnostic reporters are isolated from finalization and chart fallback.

## Guarded SQL and evidence delivery

```mermaid
sequenceDiagram
    participant Runner
    participant SQL as run_sql tool
    participant Query as Query service
    participant Policy as SQL policy
    participant Gateway as BigQuery adapter
    participant BQ as Google BigQuery
    participant Checkpoint as Conversation checkpoint
    Runner->>SQL: Validated intent and SQL arguments
    SQL->>Query: Execute using shared deadline and query budget
    Query->>Query: Check deadline and reserve query attempt
    Query->>Policy: Validate original SQL
    Policy-->>Query: Allowed SELECT or typed rejection
    Query->>Gateway: Dry run validated SQL
    Gateway->>BQ: Estimate processed bytes
    BQ-->>Query: Estimate through adapter
    Query->>Query: Enforce processing ceiling
    Query->>Gateway: Submit with maximumBytesBilled
    Gateway->>BQ: Create query job
    loop Explicit bounded result pages
        Query->>Gateway: Read page / poll completion
        Gateway->>BQ: Fetch results
        BQ-->>Query: Normalized columns and rows through adapter
        Query->>Query: Enforce row and UTF-8 result limits
    end
    Query->>Gateway: Read required job statistics
    Gateway-->>Query: Processed / billed bytes and cache status
    Query-->>SQL: Typed evidence with stable result ID
    SQL->>SQL: Preflight complete evidence for continuation
    alt Evidence fits model context
        SQL-->>Runner: Continuing content and visible evidence artifact
        Runner->>Checkpoint: Save paired result and full evidence
        Checkpoint-->>Runner: Durable write succeeded
        Runner->>Runner: Analysis wrapper grants evidence visibility
    else Evidence exceeds context capacity
        SQL-->>Runner: Compact error and unavailable evidence artifact
        Runner->>Checkpoint: Save full evidence with unavailable reference
        Note over Runner,Checkpoint: Rows were not supplied and evidence cannot support an answer
    end
```

Any policy, cost, result-size, or execution failure exits with a typed result rather than continuing the successful sequence. Rejected SQL consumes an attempt. Oversized schemas or individual rows fail; omitted rows produce explicit truncation metadata. Cost controls apply to warehouse scans independently of returned row counts. BigQuery failures request best-effort cancellation, including a job that arrives after the caller stopped waiting.

## Clarification and retry

`request_clarification` atomically saves its acknowledgment and outcome, yielding `waiting_for_user`. The user's clarification reply is a new message and run with current revision, not a resumption of the completed runner invocation.

```mermaid
sequenceDiagram
    participant Browser as ChatController
    participant Service as Conversation service
    participant DB as SQLite repository
    participant Context as Context builder
    Browser->>Service: POST retry with new clientMessageId and expectedRevision
    Service->>DB: Lookup duplicate and validate retry admission
    Note over Service,DB: Target must be an eligible latest failed, cancelled, or interrupted attempt
    DB->>DB: Create run linked to original user event and retryOfRunId
    DB-->>Service: Running retry attempt
    Service->>Context: Build history targeting retry run
    Context->>Context: Place original question at retry position
    Note over DB,Context: No duplicate stored user-message event
    Service-->>Browser: Execute through normal accepted/progress/terminal flow
```

An explicit retry uses a new submission identity. Repeating delivery of the same retry request uses the original identity and returns its existing attempt.

## Reconnect and duplicate reconciliation

```mermaid
sequenceDiagram
    participant Browser as Reloaded or disconnected tab
    participant Storage as Browser storage
    participant HTTP as Conversation API
    participant DB as SQLite repository
    Browser->>Storage: Load conversation identity and pending operation
    Browser->>HTTP: GET authoritative conversation snapshot
    HTTP->>DB: Reconcile expired runs and load history
    HTTP-->>Browser: Snapshot and revision
    alt Submission ID is present
        Browser->>Storage: Clear pending operation
        Browser->>Browser: Show durable outcome or poll running attempt
    else Submission absent and revision unchanged
        Browser->>Browser: Offer explicit resend of saved operation
        Browser->>HTTP: Resend using same clientMessageId
        HTTP->>DB: Lookup or atomically admit submission
        HTTP-->>Browser: Existing JSON result or new SSE stream
    else Submission absent and revision changed
        Browser->>Storage: Clear pending operation
        Browser->>Browser: Preserve message draft and require review of refreshed history
    end
```

Recovery does not automatically resend an uncertain request. Matching duplicates are recognized before creating another execution. Reuse of an ID for different content/operation is a submission mismatch; unseen revisions and active-run conflicts are rejected. Older snapshots do not replace newer controller state.

## Cancellation and expiry

```mermaid
sequenceDiagram
    participant Browser
    participant HTTP as SSE bridge
    participant Runner
    participant External as OpenRouter / BigQuery operations
    participant DB as SQLite repository
    Browser->>HTTP: Abort POST or cancel stream
    HTTP->>Runner: Abort shared execution signal
    Runner->>External: Stop waiting and request cleanup / job cancellation
    Note over Runner,External: Underlying SDK or remote work can outlive the caller
    alt Terminal checkpoint already started and commits successfully
        Runner->>DB: Finish awaited terminal write
        DB-->>Runner: Accepted outcome remains authoritative
    else No successful terminal commit
        Runner-->>HTTP: Execution stops with cancellation or failure
        HTTP->>DB: Service finalizes run if possible
    end
    HTTP->>HTTP: Close connection after started writes and execution settle
    Browser->>HTTP: GET snapshot to resolve durable outcome
```

An abort cannot make a started checkpoint optional. Terminal persistence success wins over cancellation/deadline expiry during that write. If a process exits before finalization, a later load or admission reconciles runs past their deadline plus a five-second grace period to `interrupted`. This is request-triggered reconciliation, not a background timer or job scheduler. Polling reads durable state and does not resume abandoned work. Arbitrarily stalled persistence callbacks are outside the runner's time bound.

## Run-state view

```mermaid
stateDiagram-v2
    [*] --> running: admitted message or retry
    running --> completed: atomic answer checkpoint
    running --> waiting_for_user: atomic clarification checkpoint
    running --> failed: execution failure finalized
    running --> cancelled: cancellation finalized
    running --> interrupted: expiry reconciliation
    completed --> [*]
    waiting_for_user --> [*]
    failed --> [*]
    cancelled --> [*]
    interrupted --> [*]
```

Terminal states do not transition back to `running`; replies and retries create new runs. Readback of durable state resolves races between terminal acceptance, failure finalization, and expiry reconciliation.

## Source references

[Conversation workflow](../../src/server/conversations/service.ts), [HTTP ownership](../../src/server/conversations/http.ts), [controller recovery](../../src/features/chat/controller.ts), [runner checkpoints](../../src/server/agent/runner.ts), [analysis tools](../../src/server/analysis/tools.ts), [query execution](../../src/server/data/query-service.ts), and [repository transactions](../../src/server/adapters/persistence/repository.ts).
