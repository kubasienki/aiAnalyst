# Explicit analytical context and evidence-backed conversational answers

## Summary

Improve the existing single-agent loop for a business user who wants to understand performance, investigate changes and ask short follow-ups.

Use the agreed model:

- **Transcript:** the record of events.
- **Structured scope:** the application’s current interpretation of those events.
- **Query evidence:** what was actually measured.
- **Answer:** supported findings, interpretation and remaining questions.

Keep natural prose with expandable details. Preserve six model calls, four SQL attempts and the existing deadline. Implement on a dedicated branch, preserving existing workspace changes.

## 1. Domain contracts and ownership

Introduce shared, runtime-validated analytical types, separate from runner and persistence types.

**Analytical scope** contains:

- Business question and analysis intent: retrieval, comparison, overview, diagnosis, methodology or presentation.
- Date range and optional comparison range.
- Metrics with definitions, units and denominators where applicable.
- Population and grain: users, sessions, purchase events or purchase items.
- Filters, grouping/granularity, selected entities and exclusions.
- Explicit assumptions and unresolved scope questions.

Use structured date ranges, filters and entity identifiers, with bounded descriptive text for definitions. Do not build a second SQL language or treat declared scope as proof of executed SQL.

**Accepted interpretation** contains the scope, relationship to the preceding analysis (`new`, `refine`, `explain`, `present` or `continue_investigation`) and an optional originating run ID.

**Findings** contain a statement, its supporting evidence IDs and its interpretation. **Open questions** contain the unresolved question and whether it is investigable from this dataset or requires outside evidence.

Responsibilities remain clear:

| Boundary | Responsibility |
|---|---|
| Analysis domain | Interpret questions, declare scope, investigate, validate answer references and express limitations |
| Conversation application | Admit runs, persist events/outcomes atomically, resolve history and manage retries |
| Context construction | Select and project recorded information for the model |
| Data layer | Enforce SQL policy, execute queries and return evidence |
| Generic runner | Iterate actions, enforce model limits and checkpoint results |
| Display projection and React | Resolve evidence into safe presentation data and render it |

Persist interpretation inside accepted answer or clarification outcomes using existing JSON storage. Add no independently mutable “current scope” table.

New tool submissions require the new contracts. Existing stored outcomes remain readable through optional versioned analytical metadata; do not backfill model-generated interpretations.

## 2. Context and follow-up behavior

Build a compact, labeled context summary from recorded accepted outcomes. Include:

- The latest accepted analytical scope, with its source run.
- Any pending clarification, kept separate from the completed analysis.
- Supported findings and unresolved questions from that analysis.
- References to relevant earlier chart/table specifications.

Label this information as a **previous interpretation**, subject to correction by the latest user message and inspection of evidence. Context reconstruction selects recorded interpretations deterministically; it does not run another model to reinterpret history.

Keep chronological transcript replay and the existing evidence-visibility rules for this iteration. Measure the summary within the existing context budget.

Do not add raw debug traces, timing/token metadata, duplicated result rows, extra reasoning transcripts or a catalog of every historical hypothesis to the summary. Preserve provider-required replay information through the existing adapter contracts.

Follow-up rules:

- Refinements preserve untouched scope fields.
- Methodology and presentation requests reuse sufficient existing evidence.
- New topics reset irrelevant filters and selected entities.
- User corrections override prior interpretations.
- “Do the analysis” continues relevant open questions.
- Failed or cancelled attempts do not replace the last accepted interpretation; their recorded intermediate evidence remains subject to existing visibility rules.
- Legacy conversations use transcript-based interpretation until a new structured outcome is accepted.

## 3. Investigation and answer acceptance

Extend existing query actions with structured query scope and the question being tested. Query scope describes that query’s intended measurement; it may differ from the overall investigation scope.

Return the declared scope with checkpointed evidence. Derive run progress from these recorded actions and results. Do not introduce a compulsory planning tool or additional model stage.

Require new answers to contain:

- A direct, natural-language narrative.
- Accepted interpretation and scope.
- Evidence-linked findings.
- Assumptions and material limitations.
- Specific open questions and optional suggested follow-ups.
- Existing chart specifications and optional table specifications.
- Honest completeness.

Data answers require at least one evidence-backed finding. Conceptual answers can have no empirical findings. Validate all finding, chart and table references against visible evidence from this conversation.

For diagnosis, the terminal answer must explain which observable contributors were investigated and what remains unresolved. A claimed complete explanation cannot also list an unresolved question necessary to answer the original request. Further optional exploration does not automatically make an answer partial.

Keep semantic assessment distinct from mechanical validation. Types and evidence IDs cannot prove that SQL matches scope or that prose follows from results.

Revise guidance to require:

- Compatible populations and a reconciled calculation before claiming an exact decomposition or largest contribution.
- “Largest observed deterioration” when only relative metric changes are supported.
- Precise funnel claims limited to measured stages.
- Specific disclosure when an investigation stops short, rather than generic causal caveats.

## 4. Business-user experience and query efficiency

Rewrite the analyst instructions around the business user and a few representative conversation examples. Remove conflicting clarification guidance.

Default to sensible interpretations for routine ambiguity: products by revenue with units as context; valuable channels by revenue per user with purchase rate and user volume. Expose those assumptions and inherit relevant dates. Clarify when ambiguity materially affects the decision, including unsupported relative dates.

Match depth to the request: concise retrieval, contextual comparison, compact overview, or adaptive diagnosis. Prioritize queries that could change the conclusion; combine related aggregates when appropriate.

Supply concise SQL capability guidance derived from the policy boundary: explicit projections, supported functions and restrictions on windows. Preserve guardrails and count repairs against existing limits.

Render:

- Natural prose and useful visuals as the main answer.
- Expandable scope, definitions, evidence-linked findings, assumptions and limitations.
- Optional suggested follow-ups that submit ordinary chat messages.
- Actual tables when requested, preserving definitions and reusing evidence.

Add bounded table specifications referencing evidence columns and formats: at most two tables, ten columns each, 200 rows, and 64 KiB combined resolved table data. Resolve values server-side; allow no model-supplied numeric table data. Disclose truncation and handle empty results explicitly.

Use readable chart labels that retain identity when names repeat, such as product name plus ID or source plus medium. Prefer contributor visuals for diagnosis and avoid repeating unchanged headline charts.

Display projection owns evidence/table resolution. React receives only selected presentation data; raw traces and provider reasoning remain in the debugger. SQL may be inspected explicitly within evidence details.

## 5. Verification and acceptance

Add focused tests for the new boundaries:

- Scope survives SQLite reopening and remains unchanged after failed/cancelled runs.
- Clarifications retain pending intent without replacing completed scope.
- Legacy and new outcomes replay together.
- Findings and presentations reject foreign or unavailable evidence.
- Context summaries preserve source references and remain within budget.
- Tables preserve evidence values and enforce limits.

Evaluate complete conversational sequences:

- Revenue → January decline → “do the analysis” → conversion methodology.
- Top product → “these sales” → “show me.”
- “December only” → “mobile only” → metric switch → exclusion → undo.
- Product analysis → new channel question without stale product filters.
- Purchaser behavior with explicit population and period.
- Presentation changes without changed definitions or unnecessary queries.
- Unsupported questions, empty results and partially completed investigations.

Use deterministic fixtures for contract and calculation checks. Use the existing live evaluation harness on isolated SQLite data to assess actual model behavior; report prompt/tool versions, SQL, findings, scope transitions and remaining questions. Do not count schema acceptance as analytical success.

Run tests, lint, typecheck and build; investigate failures and document remaining limitations. Update the assessment decision log with the state model, evaluation evidence and deferred work.

Success means follow-ups modify the intended scope, diagnoses produce supported contributor analysis, claims match evidence strength, and business users receive understandable answers with inspectable methodology.

Defer automatic transcript compaction, evidence retrieval infrastructure, separate planner/reviewer agents and a general investigation engine. Reconsider those only after evaluation identifies failures this smaller design cannot address.
