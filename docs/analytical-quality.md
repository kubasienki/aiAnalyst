# Analytical depth and evaluation

The analyst uses the existing query loop to choose an investigation depth that
fits the question. Scalar answers stay concise. Comparisons explain a relevant
baseline and the magnitude of change. Broad overviews synthesize notable
patterns. Explanatory questions verify the premise and test observable
contributors before finishing.

The narrative leads with the answer, explains supported findings and their
business implications, and separates observations from hypotheses. Charts
support specific findings. An unfinished investigation returns a partial answer
with the unanswered question in limitations. A complete investigation of
observable contributors can still disclose that causality is not established.

These are model instructions, not a guarantee of analytical correctness. Runtime
validation checks evidence availability and chart validity; it does not grade
the interpretation of that evidence. No new model calls or query budgets are
introduced.

Chart selection checks the main findings against charts in prior accepted answers,
comparing metrics, periods, filters and populations. Follow-ups refer to unchanged
earlier comparisons in prose and add visuals for new findings. Explicit requests
to repeat or omit charts take precedence. Changed scopes can warrant new charts.

Contributor comparisons can use ordinary bars of SQL-computed relative percentage
changes across metrics with different original units. Captions identify the
baseline and comparison periods and explain that those changes are not additive
revenue contributions. Undefined changes from zero or missing baselines are
omitted with an explanation, never replaced by zero. Exact decompositions require
compatible populations and reconciled totals. Chart history establishes prior
presentation, not successful rendering or access to hidden evidence rows.

## Evaluate generated answers

With warehouse and model credentials configured, run:

```sh
npm run analyst:check -- --evaluate
```

To rerun specific conversations, pass repeatable `--case=<case-id>` arguments.
Reports preserve unexpected clarifications as failed entries before stopping.

This makes live model and warehouse requests. The cases in
`scripts/analyst-evaluation-cases.ts` cover scalar answers, comparisons, context
inheritance, product rankings, funnels, explanations, premise checking, broad
overviews, and unavailable causal evidence.
They also cover prior-chart reuse, interpretation-only follow-ups, changed scopes,
repeat/omit requests, undefined changes and investigations exceeding the budget.

The report at `.data/analyst-check-report.json` contains each accepted answer,
supporting SQL and rows, execution statistics, and case-specific review criteria.
Each entry starts with `reviewStatus: "pending"`; protocol/provenance checks do
not automatically pass analytical review.

Review each conversation in order. Check the executed SQL's periods, definitions,
filters and populations, then independently compute the stated changes from its
rows. Use `npm run bigquery:verify` for available reference values. Assess every
review criterion and record pass/fail plus a supporting example in a separate
review record. Unsupported empirical or causal claims fail review even when the
prose is persuasive. An answer that repeats a chart without explaining the
requested comparison or contributors also fails. Compare reports from the same
model and dataset when assessing prompt changes.

## Implementation review, October 7, 2026

The first live chart-history conversation produced a revenue chart, then new
contributor and device comparisons, then no charts for an interpretation-only
follow-up. Changed dates produced new comparisons; explicit repeat and omit
requests were honored. A separate mobile follow-up produced a filtered chart.
The zero-baseline case correctly described revenue change as undefined and did
not fabricate a percentage. Returned rows support the reported December/January
changes: revenue -64.3%, sessions -11.2%, conversion -40.6%, and average
purchase-event value -27.8%.

That run did not pass every review criterion: the contributor chart also repeated
the already-charted revenue metric, and the narrative did not explicitly point
to the earlier chart. Guidance was tightened for both. The budget-stress case
ended in clarification rather than partial findings. A focused rerun also ended
in clarification after multiple query failures, including warehouse errors.
Prompt guidance therefore does not reliably guarantee the intended budget
fallback; this remains a failed evaluation scenario, not a passed quality gate.

A subsequent standalone explanation produced supported partial findings after
query repairs but omitted charts despite usable period-comparison evidence.
Guidance now explicitly permits separate comparisons from existing evidence
when a combined relative-change result is unavailable. That final wording has
not been rerun live. The missing-competitor-evidence case returned a partial
answer, preserving the distinction between observed change and causal diagnosis.
The full live suite has not passed; unexecuted cases remain pending.

Signed percentage bars were checked in a browser at 1100px and 390px widths:
negative/positive bars render with a zero reference line, zero remains in the
data table, and narrow displays use the existing horizontal chart scrolling
without overflowing the page. Context and chart regression tests pass.
