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

## Visual coverage follow-up

`analyst-v15` / `analysis-tools-v12` prioritize useful visual coverage of the main
findings before removing redundant charts. Trends, meaningful comparisons and
segment differences normally receive charts without an explicit request. Earlier
accepted charts can provide coverage when their metrics, periods, filters and
populations match; the narrative mentions their exact saved titles and the points
they illustrate. References remain plain prose.

Chart selection stays with the analyst, numerical validation with chart preparation,
and display with the existing UI. No new schema, investigation state, database
migration or review call is introduced. The same execution and chart limits apply.
A rejected chart should be repaired or simplified individually while retaining
other valid charts; a material missing visual is explained when limits prevent it.
This is behavioral guidance, not a mechanical guarantee of semantic visual coverage.

Evaluation now checks ordinary analytical requests without chart wording, alongside
reuse, changed scope, explicit repeat/omit requests and scalar/methodology answers.
The live harness records display titles/statuses and verifies that accepted charts
resolve for display. Human review still determines whether they illustrate the
main findings. A test exercises invalid-chart repair with another valid chart
retained, and fallback to the remaining valid chart.

The intermediate `analyst-v13` live review accepted and reopened 15 turns, with
11 charts resolving for display. Changed periods, device filters, explicit repeat
and omit requests, and interpretation-only reuse behaved as intended. This was
not a complete visual-quality pass: one continuation omitted useful checkout
coverage because of its result layout, and a scalar-to-comparison follow-up returned
only prose after producing a single wide result row. The final guidance therefore
plans chart-compatible row grain before querying and requires reshaping useful
comparisons when execution budget permits. An earlier v12 run exhausted its
six-call budget after SQL and schema repairs. These remain relevant reliability
observations; successful acceptance alone does not establish coverage.

The final v15 four-turn run accepted and reopened all answers with six charts
resolving for display: three revenue/volume/value trend charts, then three
traffic/conversion/purchase-value comparisons. Session evidence matches the
whole-month reference totals: December 133,368 observed / 2,116 purchasing
sessions; January 118,380 / 1,115. The methodology turn reused evidence with one
model call and no query or chart. The continuation tried two device queries that
were rejected, returned a partial answer and named the earlier chart titles.

This remains a qualified result. The diagnosis repeated purchase-value coverage
and did not name the earlier revenue chart, so exact-title reuse is still
inconsistent. An intermediate v14 diagnosis joined monthly revenue to daily
session counts; the final prompt adds an explicit consistent-month-key rule,
and the final run corrected that denominator error. Chart validity is enforced;
complete semantic coverage and correct SQL grain still require evaluation.
Reports are local ignored files: `.data/analyst-check-report.json` (final), and
`.data/chart-coverage-v12-report.json`, `v13-report.json`, `v14-report.json` archives
with the same `chart-coverage-` prefix. Reproduce the final sequence with
`npm run analyst:check -- --case=investigation-continuity`.

Current workspace checks passed: 400 tests, type checking, lint and diff whitespace
checks. Other work concurrently changed shared server/test files; these checks
cover the combined working tree. No browser rendering check was run for this
prompt/tool-guidance change.
