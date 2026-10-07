# Assessment decision log

## Product assumptions and decisions

Technical decisions are explained further in the video.

1) **User: a non-technical e-shop employee.** Based on Mary's answer, the task brief, and the dataset, I assumed users want actionable explanations and follow-up exploration rather than a SQL console. I focused on the Google Merchandise Store demo dataset. This does not establish what expert analysts or users with other datasets need.

2) **Investigation depth depends on intent.** An interview with an e-shop owner suggested that the same user needs quick answers, deeper investigations, and broad exploration without switching modes. The downside: the analyst may misjudge the desired depth and give too little detail or take too long. “Why?” investigates observable contributors; the dataset alone cannot establish causes.

3) **Resolve routine ambiguity without interrupting.** I assumed users prefer a visible, reasonable default over repeated clarification. Ask when interpretations could materially change the answer. Follow-ups preserve relevant scope and change only what is requested. The risk: a wrong default or inherited filter can produce a convincing answer to the wrong question.

4) **Prioritize the analysis experience over account and workspace features.** I cut accounts, authentication, a multiple-chat management UI, and persistent background execution for the assessment. I assumed evaluating one person's question-and-answer flow would be more informative. The downside: this does not demonstrate team use, convenient management of past investigations, or unattended analysis.

5) **Prefer bounded waiting and honest partial answers.** Limits on model calls, query attempts, time, and result size make execution predictable. I assumed “Thinking” and “Querying” provide enough progress information. Complex questions may remain unfinished, and coarse progress gives little indication of how much work remains. Status checks and explicit resend reduce accidental reruns but require user effort after uncertain delivery.

6) **Optimize for short and medium conversations first.** Observed conversations fit the available context, so I deferred compaction while keeping context construction separate. I assumed this covered the assessment's typical usage. The downside: sufficiently long conversations reach a hard limit rather than continuing seamlessly; compaction would need to preserve analytical scope and evidence.

7) **Let one analyst investigate adaptively.** A bounded, single-agent tool loop supports querying, inspecting results, and deciding what to do next. I assumed this was enough for useful conversational analysis. It avoids unnecessary orchestration, but provides no independent analytical reviewer - countered by verifications.

8) **Defer a rigid semantic layer.** I prioritized useful answers over a full metric catalog, assuming a single team could work with visible definitions while we learned which ones mattered. The downside: metric definitions may vary between answers. Transparency helps inspection, but non-technical users may not notice or understand those differences.

9) **Lead with natural language; make details expandable.** I assumed users value a concise conclusion with optional access to scope, definitions, assumptions, limitations, and evidence. The downside: users may act on the headline without opening details. Limitations that materially change the conclusion should therefore appear in the main answer too.

10) **Choose one model using benchmarked capabilities.** I used tool calling, analytical performance, speed, and context capacity as selection criteria, assuming these would translate into a useful experience. Benchmarks do not establish correctness on this dataset or on complete follow-up conversations; that needs direct evaluation.

11) **Choose useful charts automatically.** I assumed non-technical users benefit from seeing data at a glance without specifying chart types. Charts and prose should share evidence, scope, and definitions; unchanged charts are referenced rather than repeated. The downside: automatic choices may miss the user's preferred view, and referring back creates navigation effort.

## Where I got stuck and what I changed

I initially assumed the transcript was enough to keep investigations consistent. Testing answer quality and consistency changed that decision: I added explicit investigation state with interpreted scope, evidence-linked findings, and open questions. This gives follow-ups a clearer basis, but the recorded interpretation can still be wrong and must remain correctable by the user.

## What I would improve with another 40 hours

I would spend roughly half the time checking complete conversations against independent calculations and observing typical users. I would test whether defaults, answer depth, and expandable details help users reach the right conclusion. I would use the remaining time for improvements identified there, longer-conversation evaluation to guide context compaction, and UX changes such as clickable references to previous charts and clearer text formatting.
