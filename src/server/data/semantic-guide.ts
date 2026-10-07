import "server-only";
import { DATASET_CATALOG_VERSION } from "./dataset-catalog";

// This version covers definitions and the verified historical schema supplied
// with the prompt. Historical evidence retains its original version/snapshot.
export const SEMANTIC_GUIDE_VERSION = "ga4-sample-v7";

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


// Stable definitions that are useful on most turns; uncommon schema and event
// vocabulary is retrieved from the local catalog only when the question needs it.
export const ANALYST_CORE_GUIDE = `
Source: the public Google Merchandise Store GA4 sample, 2020-11-01 through 2021-01-31.
One source row is an event, not a user, session, order or item. The sample is obfuscated.
Common physical fields: event_date STRING (YYYYMMDD), event_name STRING, event_timestamp INTEGER
(microseconds), user_pseudo_id STRING, ecommerce.purchase_revenue_in_usd FLOAT,
device.category STRING. Tables are daily events_YYYYMMDD tables in the public dataset.
Revenue: purchase-event SUM(ecommerce.purchase_revenue_in_usd), in USD; not profit/net revenue.
Purchase counts are purchase events. Transaction IDs include placeholders/repeats; do not deduplicate.
Average purchase value = recorded purchase revenue / purchase events.
User = distinct available user_pseudo_id; it is a pseudonymous device/browser identity, not a person.
User purchase rate = purchasing users / users. Never sum distinct users over overlapping groups.
Products use recorded item.item_revenue_in_usd and item.quantity on purchase items, grouped by item_id.
Never sum event revenue after UNNEST(items); preserve missing items/quantities/revenue.
Session key = (available user_pseudo_id, ga_session_id int_value from event_params).
Activity-period session conversion = sessions with >=1 purchase / observed sessions in that period.
Do not count session_start events or session IDs alone; recompute distinct sessions for each whole period.
Detailed tags, custom event parameters, uncommon fields and ordered checkout definitions are available
through inspect_dataset(topic). Use that local catalog when needed before writing the relevant SQL.
The catalog is a convenience, never an allowlist. If a needed field/tag is unlisted, discover it with
a narrowly date- and event-bounded run_sql query. Project only the requested nested keys or aggregate;
do not load arbitrary event rows or every tag into context. The same guarded SQL boundary remains open
to supported analyses beyond the catalog. A discovery scan consumes the normal BigQuery byte budget.
Use bounded _TABLE_SUFFIX dates and event_date for reporting. Null is not zero.
Monthly keys: use DATE_TRUNC(PARSE_DATE('%Y%m%d', event_date), MONTH) in every aggregate being compared
or joined. A daily event_date renamed 'month' is not monthly; joining it to monthly totals keeps only day one.
Verify that period keys and denominators cover the same complete periods.
Use SAFE_DIVIDE and report denominators. Never average subgroup rates without their weights.
Item-list/name and source categories can be unavailable or shared. State the chosen grouping.
Record observed contributors, not causes. Missing funnel stages are not proof of abandonment.
Preserve NULL separately from zero. A NULL SUM for an unavailable-ID bucket means its amount is unknown/not recorded;
never describe it as zero, no revenue, or no impact.
`.trim();

const EVIDENCE_DEFINITIONS = {
  revenue: "Purchase revenue is the sum of ecommerce.purchase_revenue_in_usd on purchase events, in USD. Count purchases as events; transaction IDs are unreliable placeholders/repeats. This is not net revenue or profit.",
  product: "Product results use recorded item_revenue_in_usd and quantity on purchase items. Group by item_id; names can be shared or vary. UNNEST(items) changes grain: do not aggregate event-level revenue after item expansion. Preserve nulls.",
  user: "A user is a distinct available user_pseudo_id, a pseudonymous device/browser identity. Purchasing-user rate is purchasing users / users. Distinct users are not additive across overlapping groups.",
  session: "A session is (available user_pseudo_id, ga_session_id extracted from event_params.int_value), with activity in the requested dates. Session purchase conversion is sessions with >=1 purchase / observed sessions. Recompute period distincts; sessions can cross dates/months.",
  checkout: "Closed observed checkout = begin_checkout -> add_shipping_info -> add_payment_info -> purchase, in strictly increasing timestamps within the period. Match each next stage after its predecessor; count sessions once. Missing progression does not prove abandonment.",
  acquisition: "traffic_source is first-user acquisition, not session attribution. Sample source/medium varies within pseudonymous users; caveat it and do not imply ROI or unique attribution.",
};

// Persist only definitions indicated by the actual validated SQL, not the full
// prompt/catalog on every query result. The evidence keeps its original version.
export function semanticSnapshotForQuery(sql: string): string {
  const normalizedSql = sql.toLowerCase();
  const definitions: string[] = [];
  if (/purchase_revenue|purchase|transaction_id|revenue|\borders?\b/.test(normalizedSql)) definitions.push(EVIDENCE_DEFINITIONS.revenue);
  if (/items|item_|product|quantity/.test(normalizedSql)) definitions.push(EVIDENCE_DEFINITIONS.product);
  if (/user_pseudo_id|purchasing_users/.test(normalizedSql)) definitions.push(EVIDENCE_DEFINITIONS.user);
  if (/ga_session_id|session|checkout|funnel/.test(normalizedSql)) {
    definitions.push(EVIDENCE_DEFINITIONS.session);
  }
  if (/begin_checkout|add_shipping_info|add_payment_info/.test(normalizedSql)) definitions.push(EVIDENCE_DEFINITIONS.checkout);
  if (/traffic_source|campaign|medium|source/.test(normalizedSql)) definitions.push(EVIDENCE_DEFINITIONS.acquisition);
  if (definitions.length === 0) definitions.push("One source row is a recorded event. Preserve nulls and state the SQL's period and aggregation scope.");
  return `${SEMANTIC_GUIDE_VERSION}; catalog ${DATASET_CATALOG_VERSION}\n${definitions.join("\n")}`;
}
