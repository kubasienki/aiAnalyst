The strongest product framing is: **“a data analyst you can talk to,” not “natural-language SQL.”** Users will expect to ask a business question, get a defensible answer with the right chart and explanation, then interrogate that answer conversationally.

For this particular dataset, that expectation is realistic but bounded. The Google Merchandise Store sample contains three months of obfuscated GA4 ecommerce event data, from **November 1, 2020 through January 31, 2021**. Google explicitly warns that some fields contain placeholders or nulls and that obfuscation introduces limited internal consistency. [Google for Developers](https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset) The schema supports events, users, ecommerce transactions, products/items, acquisition traffic source, device, geography, and event parameters, so the natural user questions cluster around ecommerce performance, funnels, acquisition, products, and behavior. [Wsparcie Google](https://support.google.com/analytics/answer/7029846?utm_source=chatgpt.com)

## 1. The core user story

The high-level story I'd design around is:

> **As a business/product/marketing user, I want to ask questions about my ecommerce data in plain language, understand what is happening and why, and progressively explore interesting findings without needing to know the schema, SQL, or analytics terminology.**

The important word is **progressively**. A successful session probably doesn't look like one perfect prompt. It looks like:

**Question → answer → notice something → ask why → narrow segment → compare → make decision.**

For example:

> “How did revenue perform over the period?”

Then:

> “Why did it fall in January?”

Then:

> “Is that because of traffic or conversion?”

Then:

> “Break it down by device.”

Then:

> “Only mobile.”

Then:

> “Which products contributed most?”

The product succeeds when “only mobile” works exactly as the user expects without forcing them to restate the date range, metric, or analysis.

---

# 2. Most common user stories

I would expect these to cover a large majority of realistic interactions.

| User need | Example prompt | What the user actually expects |
|---|---|---|
| **Understand the dataset** | “What data do we have?” | A human explanation of available dimensions, metrics, coverage and limitations—not a schema dump |
| **Get a KPI** | “How much revenue did we make?” | Number + relevant context + trend, not just a scalar |
| **See performance over time** | “Show revenue by week” | Appropriate time-series chart + significant changes called out |
| **Compare periods** | “How did December compare with November?” | Absolute difference, % change, chart and explanation |
| **Rank things** | “What are our top products?” | Sensible interpretation, likely by revenue, with the definition made visible |
| **Segment performance** | “How does mobile compare to desktop?” | Traffic, conversion and revenue differences rather than one arbitrary metric |
| **Understand acquisition** | “Which channels bring the most valuable users?” | More than traffic volume: revenue/users/conversion or another value metric |
| **Analyze funnel** | “Where are users dropping out?” | Funnel stages, conversion between stages and biggest bottleneck |
| **Diagnose change** | “Why did sales drop?” | Decomposition into plausible drivers rather than merely restating the drop |
| **Explore behavior** | “What do purchasers do differently?” | Cohort comparison: pages, sessions, products, etc. |
| **Product analysis** | “What products are viewed a lot but rarely bought?” | View → cart → purchase relationship at item level |
| **Basket analysis** | “What do people buy with this shirt?” | Product affinity / co-purchase analysis |
| **Geo analysis** | “Which countries generate the most revenue?” | Ranked geography with volume/value context |
| **Ask follow-ups** | “What about mobile?” | Preserve previous metric, range, comparison and filters |
| **Challenge the answer** | “How did you calculate conversion?” | Transparent metric definition and ideally query/methodology |
| **Request a different representation** | “Show that as a table” | Same analysis, different presentation—not recomputation with changed definitions |

Google's own example queries are a useful proxy for likely questions: user counts, new vs returning users, transactions per purchaser, top products added to cart, purchaser vs non-purchaser behavior, page-view sequences, product affinities, and spending per purchase session. [Google for Developers](https://developers.google.com/analytics/bigquery/basic-queries)

---

# 3. The questions users will probably try first

Early-session prompts are usually broad:

| Likely question | Product implication |
|---|---|
| “Give me an overview of the business.” | You need an opinionated executive-summary mode |
| “How much revenue did we make?” | Metric definitions need to be stable |
| “How are sales trending?” | Automatically choose appropriate temporal grain |
| “What are the best-selling products?” | Resolve “best” intelligently |
| “Which channels perform best?” | Need acquisition definitions |
| “What's our conversion rate?” | Need a canonical conversion definition |
| “Where are users dropping off?” | Need event → funnel semantics |
| “How does mobile perform?” | Device segmentation |
| “Who are our best customers?” | Need careful user/value definitions |
| “What changed?” | Need comparison-period inference |
| “Anything interesting in the data?” | Need proactive insight ranking, not random correlations |

One especially useful product test is **“Give me an overview.”** It's deceptively hard.

Users generally won't want 15 charts. They will expect the system to determine something like:

**Revenue / purchases / users → overall trend → funnel → acquisition → products → 3–5 notable findings.**

That tests whether the application can behave like an analyst rather than a query interface.

---

# 4. Expected conversation patterns

Users will rapidly stop writing complete questions.

A session may look like this:

> **User:** What are our top products by revenue?  
> **App:** [analysis]  
> **User:** Ignore the top one.  
> **User:** And by quantity?  
> **User:** What about just December?  
> **User:** Why is #3 doing so well?  
> **User:** Is that mostly mobile?  
> **User:** Compare it with the same category.  
> **User:** Show me the funnel for those products.

Each turn implicitly edits the analytical state.

So internally, the system should conceptually retain something like:

**Metric:** quantity  
**Entity:** products  
**Date:** December 2020  
**Excluded:** previous #1 product  
**Segment:** potentially mobile  
**Reference set:** same product category

This conversational state is arguably more important to UX than generating sophisticated charts.

A very good contextual test is:

> “Now exclude the US and show the same thing weekly.”

The application must understand that **“the same thing”** references the previous analysis, while changing only geography and granularity.

---

# 5. User assumptions you should expect

Many of the most important UX requirements are things users will never explicitly ask for.

| User assumption | What the app needs to do |
|---|---|
| **“You know what this dataset represents.”** | Understand GA4 ecommerce semantics |
| **“You know what revenue means.”** | Use a consistent canonical definition |
| **“Users means users, not events.”** | Correct aggregation level |
| **“Orders aren't the same as purchase events.”** | Explain/deduplicate where appropriate |
| **“Top product” has an obvious meaning.** | Choose a reasonable metric and state it |
| **“Conversion rate” has an obvious meaning.** | State numerator/denominator |
| **“Last month” should just work.** | Resolve dates relative to dataset or application context consistently |
| **“Mobile” means device category mobile.** | Map common language onto schema |
| **“Traffic source means where this visit came from.”** | Avoid silently confusing acquisition with session attribution |
| **“Why?” means diagnose it.”** | Compare drivers, don't generate causal fiction |
| **“Same analysis” means literally the same definitions.** | Persist conversational state |
| **“Show me” means choose a useful chart.** | Visualization selection should be automatic |
| **“The chart and prose agree.”** | Generate both from the same result set |
| **“Numbers should add up.”** | Aggregations must remain internally consistent |
| **“If something can't be answered, tell me.”** | Explicit data limitation instead of guessing |

That acquisition issue is particularly important with GA4. The `traffic_source` record describes the source that **first acquired the user**; Google notes that it does not change when the user later interacts with another campaign. [Wsparcie Google](https://support.google.com/analytics/answer/7029846?utm_source=chatgpt.com) A user asking “Where did our December orders come from?” may assume session-level attribution, while a naïve query against `traffic_source` answers a different question.

That's exactly the sort of invisible semantic error users will perceive as “AI analytics can't be trusted.”

---

# 6. What a good answer should look like

I'd standardize responses around four layers:

**1. Answer first**

> Revenue increased 18% in December versus November.

**2. Evidence**

Chart/table showing the comparison or trend.

**3. Interpretation**

> The increase was driven mainly by more purchasers rather than a higher average order value.

**4. Exploration hooks**

> The largest changes came from mobile traffic and three product categories.

That final part is important because it naturally creates follow-up prompts.

Bad:

> “Revenue was $X.”

Better:

> “Revenue was $X, up Y% from November. Purchases rose faster than average order value, suggesting volume was the main driver. The largest increase occurred in …”

The product is doing **analysis**, not merely database retrieval.

---

# 7. Funnel questions deserve first-class treatment

This dataset is especially suitable for ecommerce journey analysis.

A natural conceptual funnel is approximately:

**Session → product view → add to cart → begin checkout → purchase**

GA4's own Purchase Journey uses `session_start`, `view_item`, `add_to_cart`, `begin_checkout`, and `purchase`; checkout analysis can go deeper through shipping and payment steps. [Wsparcie Google](https://support.google.com/analytics/answer/13128171?co=GENIE.Platform%3DDesktop\&hl=en-GB\&utm_source=chatgpt.com)

So I would expect questions like:

> “What's our purchase funnel?”  
> “Where's the biggest drop-off?”  
> “Is mobile funnel worse?”  
> “Compare desktop and mobile checkout.”  
> “Which products have high views but low add-to-cart?”  
> “Which products get added to cart but rarely purchased?”  
> “Did checkout conversion change in December?”  
> “Which traffic sources have the best conversion?”

From a UX perspective, a funnel answer should distinguish:

**step count**, **step-to-step conversion**, **overall conversion**, and **drop-off**.

Otherwise “conversion dropped by 20%” becomes ambiguous very quickly.

---

# 8. “Why?” is probably the most important advanced behavior

There are roughly three levels of analytic sophistication:

**Level 1 — Retrieval**

> “Revenue was $420K.”

**Level 2 — Comparison**

> “Revenue fell 12% week over week.”

**Level 3 — Diagnosis**

> “Revenue fell 12%. Traffic decreased 4%, purchase conversion decreased 7%, while order value was broadly stable. Mobile accounted for most of the conversion decline.”

Level 3 is where the application becomes genuinely valuable.

So these should be core user stories:

> **As a user, when I ask why a KPI changed, I want the system to break the KPI into plausible drivers so I can understand what contributed to the movement.**

> **As a user, I want the system to distinguish correlation/contribution from causality, so it doesn't claim that something “caused” the change when the data only shows association.**

This is an important evaluation criterion for an LLM analytics product.

---

# 9. Visualization expectations

Users probably don't want to specify chart types.

They expect:

| Question | Likely visualization |
|---|---|
| “How has revenue changed?” | Line |
| “Top products?” | Ranked horizontal bars |
| “Desktop vs mobile?” | Bar / grouped bars |
| “Where do users drop?” | Funnel |
| “Revenue by country?” | Bars; map only if geographically useful |
| “Channel share?” | Bar, occasionally pie |
| “Price vs conversion?” | Scatter |
| “Give me the details.” | Table |

And importantly:

> “Show revenue over time.”

followed by:

> “Break it down by device.”

should ideally **modify the existing visualization**, rather than create an unrelated answer from scratch.

---

# 10. UX expectations around ambiguity

An analytics assistant cannot ask clarification questions every time something is underspecified. That makes conversational analysis painful.

For example:

> “What are our best products?”

There are several interpretations:

**revenue, units sold, orders, purchasers, conversion, margin**.

A good default UX is:

> “By revenue, the top products are …”

with an easy path to:

> “By units instead.”

Similarly:

> “Which channel performs best?”

could reasonably default to revenue or purchase conversion, but the answer should expose the chosen interpretation.

I would use the principle:

**Make a reasonable analytical assumption when it is low-risk; show the assumption; ask only when different interpretations could materially change the decision.**

---

# 11. Trust and explainability are product requirements

For this kind of product, users eventually ask:

> “Where did this number come from?”

So every answer should have a path to something like:

**Metric definition**  
Purchase conversion = purchasing users / relevant users

**Filters**  
Device = mobile  
Dates = Dec 1–31, 2020

**Data grain**  
User-level

**Source fields/events**  
`purchase`, `user_pseudo_id`, etc.

Potentially:

**View SQL**

This does not need to clutter the default interface. It can live under “How was this calculated?”

But it is extremely valuable for trust, debugging, expert users, and testing.

---

# 12. Dataset-specific caveat that should be visible in the product

This particular sample has an unusual property: it's **obfuscated demo data**, not clean production analytics.

Google explicitly says that fields may contain `<Other>`, `NULL`, and empty strings and that internal consistency may be limited. [Google for Developers](https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset)

So I'd add a persistent but unobtrusive dataset context such as:

> **Google Merchandise Store — demo dataset**  
> Nov 1, 2020–Jan 31, 2021 · obfuscated sample data

This prevents several UX failures.

For example, if someone asks:

> “Compare this year to last year.”

The assistant shouldn't hallucinate an answer. It should say that the dataset only contains those three months.

Likewise:

> “How did we perform yesterday?”

In a demo environment, users may mean the latest dataset date rather than literal yesterday. That behavior needs an explicit design decision.

---

# 13. Product/testing scenarios I would prioritize

For QA, I would build a conversational test suite rather than testing isolated prompts.

| Test | Example | Pass condition |
|---|---|---|
| Basic retrieval | “How much revenue?” | Correct metric |
| Ambiguous metric | “Best products?” | Sensible default exposed |
| Date context | “December only” | Previous analysis + new range |
| Filter context | “Mobile only” | Existing question preserved |
| Pronoun reference | “What about those products?” | Correct entity set |
| Comparative reference | “Compared with November?” | Correct comparison |
| Metric switch | “By units instead” | Only metric changes |
| Drill-down | “Why?” | Decomposition |
| Visualization switch | “Show that as a table” | Same numbers |
| Undo/refinement | “Actually include desktop again” | State updates correctly |
| Unsupported question | “What was profit?” | Says data doesn't provide it |
| Data limitation | “Compare with 2019” | Rejects gracefully |
| Semantic trap | “Where did orders come from?” | Attribution meaning handled |
| Funnel correctness | “Cart → purchase conversion?” | Correct denominators |
| Empty result | obscure filters | Helpful empty-state explanation |
| Contradiction | chart vs narrative | Must never disagree |
| Reproducibility | “How did you calculate this?” | Definition/method shown |

I'd make these **multi-turn tests**. Testing prompts individually will miss many of the failures users care about.

---

# 14. Important personas

I wouldn't over-persona this product, because the same person changes modes. But three mental models are useful.

**Business user** asks:

> “How are we doing?”  
> “What's driving growth?”  
> “Anything concerning?”

They expect interpretation, not methodology.

**Analyst/product/marketing user** asks:

> “Break conversion down by device and source.”  
> “Compare new vs returning users.”  
> “How did you define sessions?”

They expect precision and control.

**Data-savvy user** asks:

> “Show me the SQL.”  
> “Use user_pseudo_id.”  
> “Use purchase_revenue instead.”  
> “Don't use first-touch traffic source.”

They expect the conversation to respect explicitly supplied analytical logic.

Ideally the same interface supports all three progressively rather than exposing separate modes.

---

# 15. The key user stories I would actually put into a PRD

The most important ones can be summarized as:

> **As a user, I can ask an analytics question using business language rather than database terminology.**

> **As a user, I receive the answer, an appropriate visualization, and a concise explanation of what matters.**

> **As a user, I can ask follow-up questions without repeating the original context.**

> **As a user, I can refine an analysis by changing one dimension, metric, period, segment, or filter conversationally.**

> **As a user, I can ask “why?” and receive analysis of likely contributing factors rather than a restatement of the result.**

> **As a user, ambiguous concepts such as “best,” “conversion,” or “users” are interpreted sensibly and the chosen definition is visible.**

> **As a user, I can understand how a result was calculated and inspect its assumptions.**

> **As a user, I am told when the available data cannot answer my question instead of receiving an invented answer.**

> **As a user, charts, tables, KPI values, and written conclusions always use the same filters and definitions.**

> **As a user, I can move naturally from an executive question to detailed investigation in the same conversation.**

---

## The biggest product insight

I would **not** evaluate this primarily on “Can it translate natural language into correct SQL?”

The more meaningful UX contract is:

**Does it preserve analytical intent across a conversation?**

A user who asks:

> “Why did revenue fall in January?”  
> “Is it mobile?”  
> “Which channels?”  
> “Only new users.”  
> “Compare that with December.”  
> “Which products explain the difference?”

expects one continuously evolving investigation.

If your application gets the SQL right on all six prompts individually but loses context between turns, users will still experience it as a poor analyst. Conversely, if it reliably maintains **metric + date + population + filters + comparison + entity context**, makes assumptions visible, and explains limitations, it will feel much closer to working with a competent human analyst.
