import "server-only";

// Verified against every daily table in the fixed public sample on 2026-10-07.
// Preserve historical/obfuscated types rather than copying today's GA4 schema.
export const DATASET_SCHEMA = `
event_date: STRING
event_timestamp: INTEGER
event_name: STRING
event_params: RECORD[]
  key: STRING
  value: RECORD
    string_value: STRING
    int_value: INTEGER
    float_value: FLOAT
    double_value: FLOAT
event_previous_timestamp: INTEGER
event_value_in_usd: FLOAT
event_bundle_sequence_id: INTEGER
event_server_timestamp_offset: INTEGER
user_id: STRING
user_pseudo_id: STRING
privacy_info: RECORD
  analytics_storage: INTEGER
  ads_storage: INTEGER
  uses_transient_token: STRING
user_properties: RECORD[]
  key: INTEGER
  value: RECORD
    string_value: INTEGER
    int_value: INTEGER
    float_value: INTEGER
    double_value: INTEGER
    set_timestamp_micros: INTEGER
user_first_touch_timestamp: INTEGER
user_ltv: RECORD
  revenue: FLOAT
  currency: STRING
device: RECORD
  category: STRING
  mobile_brand_name: STRING
  mobile_model_name: STRING
  mobile_marketing_name: STRING
  mobile_os_hardware_model: INTEGER
  operating_system: STRING
  operating_system_version: STRING
  vendor_id: INTEGER
  advertising_id: INTEGER
  language: STRING
  is_limited_ad_tracking: STRING
  time_zone_offset_seconds: INTEGER
  web_info: RECORD
    browser: STRING
    browser_version: STRING
geo: RECORD
  continent: STRING
  sub_continent: STRING
  country: STRING
  region: STRING
  city: STRING
  metro: STRING
app_info: RECORD
  id: STRING
  version: STRING
  install_store: STRING
  firebase_app_id: STRING
  install_source: STRING
traffic_source: RECORD
  medium: STRING
  name: STRING
  source: STRING
stream_id: INTEGER
platform: STRING
event_dimensions: RECORD
  hostname: STRING
ecommerce: RECORD
  total_item_quantity: INTEGER
  purchase_revenue_in_usd: FLOAT
  purchase_revenue: FLOAT
  refund_value_in_usd: FLOAT
  refund_value: FLOAT
  shipping_value_in_usd: FLOAT
  shipping_value: FLOAT
  tax_value_in_usd: FLOAT
  tax_value: FLOAT
  unique_items: INTEGER
  transaction_id: STRING
items: RECORD[]
  item_id: STRING
  item_name: STRING
  item_brand: STRING
  item_variant: STRING
  item_category: STRING
  item_category2: STRING
  item_category3: STRING
  item_category4: STRING
  item_category5: STRING
  price_in_usd: FLOAT
  price: FLOAT
  quantity: INTEGER
  item_revenue_in_usd: FLOAT
  item_revenue: FLOAT
  item_refund_in_usd: FLOAT
  item_refund: FLOAT
  coupon: STRING
  affiliation: STRING
  location_id: STRING
  item_list_id: STRING
  item_list_name: STRING
  item_list_index: STRING
  promotion_id: STRING
  promotion_name: STRING
  creative_name: STRING
  creative_slot: STRING
`.trim();

export const PARAMETER_GUIDANCE = `
event_params is an array of {key, value: {string_value, int_value, float_value, double_value}}.
ga_session_id: int_value; one occurrence per event verified over all available dates.
ga_session_number: int_value observed on the inspected day.
page_location and page_title: string_value observed on the inspected day.
session_engaged: string_value OR int_value observed on the inspected day; do not assume one type.
purchase value: int_value OR double_value observed on the inspected day; use ecommerce USD revenue for revenue.
Extract needed keys with correlated subqueries; never cross join event_params with items to calculate revenue.
A one-day parameter observation is not a promise of full-period coverage or uniqueness for other keys.
is_active_user, collected_traffic_source, session_traffic_source_last_click,
items.item_params and modern batch ordering fields are absent. Do not invent them.
`.trim();
