import "server-only";

// This version covers definitions and the verified historical schema supplied
// with the prompt. Historical evidence retains its original version/snapshot.
export const SEMANTIC_GUIDE_VERSION = "ga4-sample-v2";

export const SEMANTIC_GUIDE = `
Source: bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_* (BigQuery US).
Google Merchandise Store, an online store selling Google-branded merchandise.
Available dates: 2020-11-01 through 2021-01-31. One table per exported calendar day.
One source row is a recorded event, not a user, session, deduplicated order, or item sale.
The sample is obfuscated, with placeholders and imperfect internal consistency.

Revenue: SUM(ecommerce.purchase_revenue_in_usd) WHERE event_name = 'purchase'.
Recorded purchase revenue in USD, not profit, accounting income or net revenue after refunds.
Purchases: count purchase events; never label them deduplicated orders.
Transaction IDs include NULL, '', '<Other>', '(not set)' and can repeat across users/values.
Do not deduplicate revenue or purchases on transaction_id without a justified separate definition.
Average purchase value: revenue / purchase-event count, not deduplicated average order value.
No refund events were observed in inspection; that does not establish real-world zero refunds.

Users: distinct available user_pseudo_id across the whole requested scope, not identified people.
Exclude missing/empty/placeholder identities; there is no usable user_id in this sample.
This is total pseudonymous users, not GA4 UI active users or cross-device people.
Purchasing users: distinct available user_pseudo_id with a purchase event.
User purchase rate: purchasing users / users.
Never sum grouped daily/device/channel distinct-user counts to infer total users.

Products: UNNEST(items) on purchase events; sum recorded item.item_revenue_in_usd.
Units: SUM(item.quantity); preserve missing quantity rather than substituting one.
Recorded item revenue can differ from price times quantity; do not recompute it.
Product identity is item_id. Names can cover multiple IDs and one ID can have multiple names.
Group by ID with a deterministic name label, e.g. MAX(item_name). Preserve unavailable IDs
as a clearly unknown bucket, not a named product; disclose missing identity/revenue/quantity.
Item and event revenue need not reconcile. Never sum event revenue after expanding item rows.

Sessions: unique (available user_pseudo_id, non-null ga_session_id integer parameter) pairs
with recorded activity within the requested period. Group by both columns, not bare session ID.
Do not count session_start events as sessions; some observed sessions lack that event.
Sessions can cross midnight and months; do not reset at midnight or sum period distinct counts.
This is an activity-period definition, not sessions starting in the period with later outcomes.
Session conversion: sessions containing a purchase in the requested period / observed sessions
in that same period. Multiple purchase events in one session still count once in the numerator.
This is the default for unspecified conversion; state it, and honor contextual alternatives.
Session dimensions must be assigned once per session. Device category was consistent within
observed sessions in monthly checks; other dimensions are not automatically session-stable.

Checkout funnel: CLOSED observed session progression begin_checkout -> add_shipping_info ->
add_payment_info -> purchase, with strictly increasing timestamps and all events in the period.
For each user/session, find earliest checkout, then earliest shipping AFTER that checkout,
then earliest payment AFTER matched shipping, then earliest purchase AFTER matched payment.
Do not compare independent stage minima: earlier stages may be followed by valid repeated stages.
Count each session once; do not substitute raw event counts or unordered stage-presence counts.
Tied timestamps cannot establish sequence and are excluded by strict ordering.
Report stage counts, conditional progression rates and observed non-progression.
Missing recorded progression is not proof of actual customer abandonment or its cause.
This ordered funnel does not include every purchase. State its definition and period boundaries.

Use SAFE_DIVIDE and return numerator/denominator counts with rates.
Never average subgroup rates without numerator/denominator weights.
Recompute period distinct counts from events; do not add overlapping subgroup distinct counts.
Preserve NULL versus zero; empty SUMs and undefined ratios are not observed zeroes.
Distinguish relative percent change from percentage-point change.
Device: device.category. Country: geo.country. Event date: event_date (YYYYMMDD).
Use exported event_date for calendar reports, not a guessed timezone from timestamp examples.
event_timestamp is microseconds; the historical schema lacks modern batch ordering fields.
traffic_source denotes FIRST-USER acquisition, not session attribution. In this obfuscated
sample it varies for some pseudonymous users. Caveat breakdowns of recorded acquisition fields;
do not assert reliable attribution, infer ad ROI, or sum overlapping source user counts.
'<Other>', '(not set)', '(data deleted)', NULL and empty strings are unavailable/obfuscated labels,
not ordinary business categories. Do not silently drop their contribution from whole-store totals.
Engagement/bounce metrics and session attribution are not verified default capabilities.
No cost, margin, ad spend, inventory, experiment or reliable customer identity data is supplied.
Do not claim causal explanations from associations; describe observed contributors and limits.

SQL: one read-only SELECT, optional CTEs/subqueries/joins/UNNEST on existing arrays.
Select explicit columns; no SELECT *, scripts, writes, external sources, routines or window functions.
Each events_* scan needs mandatory literal _TABLE_SUFFIX bounds inside available dates.
Select only necessary fields: projecting whole repeated arrays can exceed processing limits.
Use the supported built-in subset and adapt supplied examples rather than bypassing validation.
Service truncation is an incomplete prefix. SQL top-N is a deliberate subset, not a population total.
`.trim();
