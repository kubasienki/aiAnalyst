import "server-only";

const source = "`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`";

export function sessionEventsSql(from: string, to: string): string {
  // Only fixed developer-owned periods call this helper; it is not a SQL tool API.
  return `SELECT user_pseudo_id, event_name, event_timestamp, device.category AS device,
    (SELECT MAX(value.int_value) FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '${from}' AND '${to}'
    AND user_pseudo_id IS NOT NULL AND user_pseudo_id NOT IN ('', '<Other>', '(not set)', '(data deleted)')`;
}

export function orderedCheckoutSql(eventsSql: string): string {
  // Match the next eligible event, rather than independent stage minima. A
  // shipping event before checkout must not hide a later eligible shipping event.
  return `WITH events AS (${eventsSql}),
    checkout AS (
      SELECT user_pseudo_id, session_id, MIN(event_timestamp) AS checkout_at
      FROM events WHERE event_name = 'begin_checkout' AND session_id IS NOT NULL
      GROUP BY user_pseudo_id, session_id
    ), shipping AS (
      SELECT c.user_pseudo_id, c.session_id, MIN(e.event_timestamp) AS shipping_at
      FROM checkout c JOIN events e ON c.user_pseudo_id = e.user_pseudo_id
      AND c.session_id = e.session_id AND e.event_timestamp > c.checkout_at
      WHERE e.event_name = 'add_shipping_info' GROUP BY c.user_pseudo_id, c.session_id
    ), payment AS (
      SELECT s.user_pseudo_id, s.session_id, MIN(e.event_timestamp) AS payment_at
      FROM shipping s JOIN events e ON s.user_pseudo_id = e.user_pseudo_id
      AND s.session_id = e.session_id AND e.event_timestamp > s.shipping_at
      WHERE e.event_name = 'add_payment_info' GROUP BY s.user_pseudo_id, s.session_id
    ), purchased AS (
      SELECT p.user_pseudo_id, p.session_id, MIN(e.event_timestamp) AS purchase_at
      FROM payment p JOIN events e ON p.user_pseudo_id = e.user_pseudo_id
      AND p.session_id = e.session_id AND e.event_timestamp > p.payment_at
      WHERE e.event_name = 'purchase' GROUP BY p.user_pseudo_id, p.session_id
    ) SELECT
      (SELECT COUNT(*) FROM checkout) AS checkout_sessions,
      (SELECT COUNT(*) FROM shipping) AS shipping_sessions,
      (SELECT COUNT(*) FROM payment) AS payment_sessions,
      (SELECT COUNT(*) FROM purchased) AS purchase_sessions
    FROM (SELECT COUNT(*) AS event_count FROM events) totals`;
}

export const REFERENCE_QUERIES = {
  decemberRevenue: `SELECT SUM(ecommerce.purchase_revenue_in_usd) AS revenue_usd
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231'
    AND event_name = 'purchase'`,
  revenueByDevice: `SELECT SUBSTR(event_date, 1, 6) AS month, device.category AS device,
    SUM(ecommerce.purchase_revenue_in_usd) AS revenue_usd
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201101' AND '20201231'
    AND event_name = 'purchase' GROUP BY month, device ORDER BY month, device`,
  decemberUsers: `SELECT COUNT(DISTINCT user_pseudo_id) AS users
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231'
    AND user_pseudo_id IS NOT NULL AND user_pseudo_id NOT IN ('', '<Other>', '(not set)', '(data deleted)')`,
  januaryProducts: `SELECT item.item_id, MAX(item.item_name) AS item_name,
    SUM(item.item_revenue_in_usd) AS revenue_usd, SUM(item.quantity) AS quantity
    FROM ${source}, UNNEST(items) AS item
    WHERE _TABLE_SUFFIX BETWEEN '20210101' AND '20210131' AND event_name = 'purchase'
    AND item.item_id IS NOT NULL AND item.item_id NOT IN ('', '<Other>', '(not set)', '(data deleted)')
    GROUP BY item.item_id ORDER BY revenue_usd DESC, item.item_id LIMIT 10`,
  decemberSessionConversion: `WITH events AS (${sessionEventsSql("20201201", "20201231")}),
    sessions AS (SELECT user_pseudo_id, session_id, COUNTIF(event_name = 'purchase') AS purchases
      FROM events WHERE session_id IS NOT NULL GROUP BY user_pseudo_id, session_id)
    SELECT COUNT(*) AS sessions, COUNTIF(purchases > 0) AS purchasing_sessions,
      SAFE_DIVIDE(COUNTIF(purchases > 0), COUNT(*)) AS session_purchase_rate FROM sessions`,
  decemberFirstParameterInventory: `SELECT parameter.key,
    COUNT(*) AS parameter_occurrences,
    COUNTIF(parameter.value.string_value IS NOT NULL) AS string_occurrences,
    COUNTIF(parameter.value.int_value IS NOT NULL) AS integer_occurrences,
    COUNTIF(parameter.value.float_value IS NOT NULL) AS float_occurrences,
    COUNTIF(parameter.value.double_value IS NOT NULL) AS double_occurrences
    FROM ${source} CROSS JOIN UNNEST(event_params) AS parameter
    WHERE _TABLE_SUFFIX = '20201201'
    GROUP BY parameter.key ORDER BY parameter.key`,
  decemberCheckout: orderedCheckoutSql(sessionEventsSql("20201201", "20201231")),
};
