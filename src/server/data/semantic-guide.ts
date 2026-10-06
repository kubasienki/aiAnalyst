export const SEMANTIC_GUIDE_VERSION = "ga4-sample-v1";

export const SEMANTIC_GUIDE = `
Source: bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*.
Available dates: 2020-11-01 through 2021-01-31. Use bounded literal _TABLE_SUFFIX filters.
One source row is a recorded event, not a user, session, or deduplicated order.
Revenue: SUM(ecommerce.purchase_revenue_in_usd) WHERE event_name = 'purchase'.
This is purchase revenue in USD, not net revenue after refunds.
Purchases: count purchase events. Do not label them deduplicated orders.
Users: distinct non-null user_pseudo_id across the whole requested scope.
Purchasing users: distinct non-null user_pseudo_id with a purchase event.
User purchase rate: purchasing users / users; use SAFE_DIVIDE.
Never sum grouped daily/device distinct-user counts to infer total users.
Never average subgroup rates without their numerator/denominator weights.
Products: UNNEST(items) on purchase events; sum item.item_revenue_in_usd.
Product identity: item_id; item names can be shared by multiple IDs. State grouping choices.
Never sum event-level purchase revenue after expanding item rows.
Preserve null versus zero; empty sums and undefined ratios are not observed zeroes.
Device: device.category. Country: geo.country. Event date: event_date (YYYYMMDD).
traffic_source exists in the historical schema. Acquisition meaning needs verification.
collected_traffic_source and session_traffic_source_last_click are absent in the inspected table.
event_params is a repeated key/value record, not a flat map. Select only needed fields.
Session conversion and ordered checkout funnels are not verified capabilities yet.
The sample is obfuscated and has placeholders and imperfect internal consistency.
Inspection found 5692 purchase events, 4452 distinct non-placeholder transaction IDs,
and 23 events with unavailable transaction IDs. This does not establish a deduplication rule.
Full-period event revenue was $362165 and item revenue $362110; do not force reconciliation.
Do not claim causal explanations from observed associations.
SQL must pass the supported execution policy. Unsupported syntax cannot bypass validation.
`.trim();
