# Backend guidelines

Apply the repository guidelines, with particular care around asynchronous work
and external services.

## Services and adapters

- Application services own workflow rules and budgets. Adapters own SDK calls,
  provider-specific behavior, and conversion into application types.
- Construct dependencies in the configuration/composition layer. Keep services
  independent of Next.js request objects and vendor SDK types where practical.
- Break complex services into named phases. Result paging and normalization
  should not bury the main execution sequence.
- Isolate parser-specific AST assumptions in clearly named helpers. Keep source,
  expression, and date-bound policy checks understandable independently.

## Async execution

- Await work that must complete before returning. Avoid unhandled promises.
- Use concurrency only for independent operations. Remember that `Promise.all`
  failing does not cancel its other operations.
- Distinguish stopping the caller's wait from cancelling the underlying operation.
- Make deadline, abort, and cleanup paths explicit. Explain necessary background
  cleanup and handle its rejection deliberately.
- Share a run's budget across its operations. Explain mutations and recheck shared
  limits after awaits when concurrent callers could change them.
- Avoid mutable global request or conversation state. Pass run state explicitly.

## Errors and evidence

- Use explicit error categories at application boundaries. Do not expose raw SDK
  errors, credentials, or sensitive configuration to callers.
- Preserve useful diagnostic information through a deliberate internal mechanism;
  do not replace failures with fabricated successful results.
- Document intentional best-effort cleanup, including why a failure can be ignored.
- Keep result limits, truncation, units, and numeric precision explicit.
- Test cancellation, deadlines, budget limits, and adapter edge cases when changing
  those behaviors. Use independent expected results for analytical correctness.
