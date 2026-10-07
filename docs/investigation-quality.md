# Investigation quality: first implementation slice

This implements the narrowed plan, superseding the broader implementation order
in `analytical-context-implementation-plan.md`.

## Decisions

The intended user is a business, product or marketing user asking what changed,
what explains it, and what to investigate next. The observed weakness was weak
investigation and answer composition, rather than demonstrated loss of history.
Keep one handwritten agent loop and its six model calls, four SQL attempts and
shared deadline.

New accepted answers include versioned analysis metadata: a resolved question,
intent, period/comparison, important filters, population and follow-up mode;
ranked evidence-linked findings; and useful open questions. Each open question
states whether the dataset can investigate it, whether it is necessary to answer
the current request, and any specific obstacle. Historical answers remain valid
without metadata. No database migration or independently mutable state is needed.

Transcript events remain the record. Accepted metadata is a fallible interpretation
of those events; actual SQL/results establish what was measured. Latest user
corrections override previous interpretations. Existing terminal-outcome replay
already supplies this metadata to follow-ups, without an extra summary message.
Failed/cancelled attempts retain their existing debug records but do not create
accepted analytical context.

The runner exposes only whether the next request can take a continuing action,
including its reserved terminal-only final request. The analysis boundary combines
that capability with SQL and deadline limits. A diagnosis cannot finish early with
a necessary, dataset-investigable question and no obstacle while a further test is
possible. Otherwise a supported partial answer names the remaining gap. Optional
exploration never blocks completion. Evidence references and declared completeness
are validated; code cannot prove semantic claim support or whether a model-declared
obstacle is justified. Those remain explicit evaluation responsibilities.

Prose gives the conclusion once, minimal supporting numbers and proportionate
interpretation. Details show context, findings, assumptions and limitations without
repeating them as another main answer. Material unresolved issues belong in the
partial answer's prose too. Existing charts support new findings where useful.

## Verification

Focused tests cover new-submission requirements, finding references, diagnostic
early stopping, model/SQL/result-byte limits, optional exploration, data obstacles,
false completeness, metadata replay alongside legacy outcomes and failed attempts.
The live harness adds revenue investigation and correction/topic-change sequences,
and records prompt/tool versions and measured context overhead with SQL and rows.
Live analytical review must inspect conclusions, scope, useful new tests and reuse;
an accepted tool response alone is not a quality pass.

The final live run (`analyst-v11`, `analysis-tools-v8`) accepted and reopened all
seven turns. The revenue continuation added a device test rather than repeating
the overview. Device revenue losses sum to $103,205, matching the whole-store loss;
desktop's $65,978 loss supports its approximately 64% contribution claim. The
methodology turn reused evidence with one model call and no SQL. The correction
replaced mobile with desktop and preserved December versus November; the new
acquisition question reset the device filter and restored the full sample period.

This is a qualified analytical result. Some answers remain dense and the methodology
metadata widened the active period to both months, although the prose kept the right
comparison. The acquisition ranking used independent MAX source/medium assignments
despite finding 42,260 users with multiple pairs; its caveat does not establish a
reliable acquisition ranking. Schema and chart repairs still consume calls. An
earlier run timed out reading query results and another exhausted repair allowance.
Bounded field-path feedback fixed otherwise opaque validation errors; execution
failure reports now retain SQL attempts and safe tool feedback. These observations
are remaining evaluation targets, not claims that semantic correctness is enforced.

Local checks passed: 383 tests, lint, type checking and the production build.
Reproduce the live sequences with `npm run analyst:check --
--case=investigation-continuity --case=correction-and-topic-change`; inspect
`.data/analyst-check-report.json` for narratives, executed SQL, rows, feedback and
context measurements. The report is local and ignored by Git.

The sandboxed Next.js TypeScript subprocess returned empty output; running the same
production build outside the sandbox completed successfully. No compiler checks
were disabled.

## Deferred

No table subsystem, new SQL inspection API, historical summary projection, richer
analytical-state schema, extra planning/review agent or general investigation engine.
With additional time, calibrate semantic evaluation on independent calculations,
measure how often declared obstacles or missed open questions permit early stopping,
and introduce richer scope or retrieval only when failures justify it.
