import "server-only";
import { DATASET_SCHEMA, PARAMETER_GUIDANCE } from "./dataset-schema";
import { orderedCheckoutSql, checkoutStageRowsSql, checkoutTransitionRowsSql, sessionEventsSql } from "./reference-queries";

export const DATASET_CATALOG_VERSION = "ga4-sample-catalog-v3";

type CatalogSection = { id: string; title: string; terms: string[]; content: string };

const sessions = sessionEventsSql("20201201", "20201231");
const sections: CatalogSection[] = [
  {
    id: "physical_schema",
    title: "Historical physical schema",
    terms: ["schema", "field", "fields", "column", "columns", "type", "types", "nested", "record", "repeated", "table"],
    content: `The 92 daily tables have the same schema. Source dates: 2020-11-01 through 2021-01-31.\n${DATASET_SCHEMA}\n${[
      "event_params is REPEATED STRUCT<key STRING, value STRUCT<string_value STRING,int_value INTEGER,float_value FLOAT,double_value FLOAT>>.",
      "items is REPEATED RECORD; ecommerce, device, geo, event_dimensions, app_info, privacy_info, user_ltv and traffic_source are records.",
      "Historical fields is_active_user, collected_traffic_source, session_traffic_source_last_click, items.item_params and modern batch-ordering fields are absent.",
    ].join("\n")}\n${PARAMETER_GUIDANCE}`,
  },
  {
    id: "event_names_and_tags",
    title: "Observed event names and GA4 event tags",
    terms: ["event", "events", "tag", "tags", "journey", "behavior", "behavioral", "commerce", "view_item_list", "view_promotion", "select_promotion", "begin_checkout", "add_to_cart", "purchase"],
    content: `These 17 event_name values occurred across all 92 sample tables: page_view, user_engagement, scroll, view_item, session_start, first_visit, view_promotion, add_to_cart, begin_checkout, select_item, view_search_results, add_shipping_info, add_payment_info, select_promotion, purchase, click, view_item_list.\nevent_name values are data, not values enumerated in the SQL schema. Observing an event does not make its count equivalent to a user/session or prove a full customer journey.`,
  },
  {
    id: "product_listing_and_promotion",
    title: "Product-list and promotion tags",
    terms: ["list", "listing", "listings", "merchandising", "promotion", "promotions", "promo", "impression", "selection", "item_list_id", "item_list_name", "item_list_index"],
    content: `Observed listing/promotion events: view_item_list, select_item, view_promotion, select_promotion. The items array has item_list_id STRING, item_list_name STRING, item_list_index STRING, promotion_id STRING, promotion_name STRING, creative_name STRING and creative_slot STRING. Catalog inspection saw view_item_list only 71 times across the sample; do not assume this is complete product-impression coverage.\nThese fields are item-scoped repeated records. UNNEST(items) changes row grain to an item; never then sum event-level purchase revenue. Group item analysis by item_id and state any unavailable identities.`,
  },
  {
    id: "event_parameter_keys",
    title: "Observed repeated event parameter keys and value types",
    terms: ["parameter", "parameters", "param", "params", "key", "keys", "session", "engagement", "campaign", "source", "medium", "page", "search", "coupon", "currency", "transaction", "shipping", "value", "term", "click", "gclid", "ga_session_id", "ga_session_number", "session_engaged", "page_location", "page_referrer", "engagement_time_msec"],
    content: `The following 33 event_params.key values were inventoried on 2020-12-01 only: ga_session_id (INTEGER), ga_session_number (INTEGER), page_location (STRING), page_title (STRING), engaged_session_event (INTEGER), session_engaged (STRING and INTEGER), debug_mode (INTEGER), all_data (no typed value observed), clean_event (STRING), page_referrer (STRING), engagement_time_msec (INTEGER), campaign (STRING), medium (STRING), source (STRING), percent_scrolled (INTEGER), term (STRING), entrances (INTEGER), gclid (no typed value observed), gclsrc (no typed value observed), currency (STRING), search_term (STRING), unique_search_term (INTEGER), value (INTEGER and FLOAT), payment_type (STRING), transaction_id (STRING), tax (INTEGER and FLOAT), shipping_tier (STRING), promotion_name (STRING), coupon (STRING), dclid (no typed value observed), link_domain (STRING), outbound (STRING), link_url (STRING).\nThis is a partial observed inventory, not an allowlist or a coverage guarantee for other dates. A key/value tag is not a physical table column. For an unlisted key, discover only within the dates and event types needed by the question using a bounded run_sql query that unnests event_params and selects the key/value fields needed. For example, group by parameter.key and count parameter occurrences; call that an occurrence count, not an event count. The normal dry-run, date-range and bytes-billed limits still apply. A correlated extraction is useful for known keys: (SELECT MAX(value.int_value) FROM UNNEST(event_params) WHERE key = 'ga_session_id'). MAX is safe for this key only because exactly one occurrence was verified per event over the complete sample. Do not use it to hide duplicate keys for arbitrary parameters. Avoid cross joining the full parameter array with items.`,
  },
  {
    id: "sessions_and_checkout",
    title: "Session identity and ordered checkout fields",
    terms: ["session", "sessions", "checkout", "funnel", "abandonment", "conversion", "dropoff", "drop-off", "stage", "ga_session_id", "begin_checkout", "add_shipping_info", "add_payment_info"],
    content: `Session key is (available user_pseudo_id, ga_session_id extracted from event_params.int_value). Bare session IDs collide across users. The ID occurs once per event in all inspected dates; some sessions have no session_start, and 20 identities cross month boundaries.\nObserved closed checkout progression: begin_checkout -> add_shipping_info -> add_payment_info -> purchase. The dated event query should select user_pseudo_id, event_name, event_timestamp and ga_session_id, filtered to only these event names and the requested literal table-date range. Match the earliest eligible next event AFTER each preceding matched timestamp; count each session once. An ordered progression is evidence of recorded stages, not proof of actual abandonment. Strict timestamp ties cannot establish order.\nChart stage rows need stage_order, a readable stage label, and session count; use Started checkout, Added shipping details, Added payment details, Recorded purchase. Transition rows need transition_order, a readable transition label, preceding_sessions, next_sessions, progression_rate and non_progression_rate. Progression = next / preceding; non-progression = (preceding - next) / preceding. SAFE_DIVIDE preserves undefined rates when preceding is zero. ORDER BY the numeric journey position, never alphabetically or by rate. For multi-period comparison, preserve separate populations and use periods as series, not transitions. Shipping/payment details do not mean shipment or confirmed payment.\nDecember reference SQL pattern:\n${orderedCheckoutSql(sessions)}\nStage chart query pattern:\n${checkoutStageRowsSql(orderedCheckoutSql(sessions))}\nTransition chart query pattern:\n${checkoutTransitionRowsSql(orderedCheckoutSql(sessions))}`,
  },
  {
    id: "traffic_and_acquisition",
    title: "Traffic-source fields and scope",
    terms: ["traffic", "acquisition", "source", "medium", "campaign", "channel", "attribution", "marketing", "traffic_source"],
    content: `traffic_source.source, traffic_source.medium and traffic_source.name are physical first-user acquisition fields in this historical schema. They do not represent session attribution. This obfuscated sample records multiple source/medium pairs for 42,260 pseudonymous users. No ad spend is present, so this cannot establish ROI. event_params also had campaign, medium, source, term, gclid and dclid on the inspected day; these event parameters are not guaranteed session attribution fields.`,
  },
];

export type DatasetCatalogResult = {
  version: string;
  topic: string;
  sections: { id: string; title: string; content: string }[];
  note: string;
};

export function describeDatasetTopic(topic: string): DatasetCatalogResult {
  const normalizedTopic = topic.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
  const topicWords = new Set(normalizedTopic.split(/\s+/).filter(Boolean));
  const ranked = sections.map((section, index) => ({
    section,
    index,
    score: section.terms.reduce((score, term) => score + (topicWords.has(term) ? 1 : 0), 0),
  })).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked.slice(0, 2).map(({ section }) => ({ id: section.id, title: section.title, content: section.content }));
  return {
    version: DATASET_CATALOG_VERSION,
    topic,
    sections: selected,
    note: selected.length > 0
      ? "Static verified metadata only. It does not read or count BigQuery event rows. Catalog entries are discovery guidance, not an allowlist; parameter inventory coverage is explicitly labeled by inspection period."
      : "No matching verified catalog entry. This does not prove the field or tag is absent or unavailable. Consider a narrowly bounded read-only discovery query only when needed.",
  };
}
