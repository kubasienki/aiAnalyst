const source = "`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`";

export const REFERENCE_QUERIES = {
  decemberRevenue: `SELECT SUM(ecommerce.purchase_revenue_in_usd) AS revenue_usd
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231'
    AND event_name = 'purchase'`,
  revenueByDevice: `SELECT SUBSTR(event_date, 1, 6) AS month, device.category AS device,
    SUM(ecommerce.purchase_revenue_in_usd) AS revenue_usd
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201101' AND '20201231'
    AND event_name = 'purchase' GROUP BY month, device ORDER BY month, device`,
  decemberUsers: `SELECT COUNT(DISTINCT user_pseudo_id) AS users
    FROM ${source} WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231'`,
  januaryProducts: `SELECT item.item_id, item.item_name,
    SUM(item.item_revenue_in_usd) AS revenue_usd, SUM(item.quantity) AS quantity
    FROM ${source}, UNNEST(items) AS item
    WHERE _TABLE_SUFFIX BETWEEN '20210101' AND '20210131' AND event_name = 'purchase'
    GROUP BY item.item_id, item.item_name ORDER BY revenue_usd DESC LIMIT 10`,
};
