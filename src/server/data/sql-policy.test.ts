import { describe, expect, it } from "vitest";
import { REFERENCE_QUERIES, checkoutStageRowsSql, checkoutTransitionRowsSql } from "./reference-queries";
import { validateSql } from "./sql-policy";

const table = "`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`";
const bounded = `SELECT COUNT(*) AS n FROM ${table} WHERE _TABLE_SUFFIX = '20201201'`;

describe("SQL policy", () => {
  it.each([checkoutStageRowsSql, checkoutTransitionRowsSql])("accepts checkout chart shaping without widening SQL policy", shapeQuery => {
    const sql = shapeQuery(REFERENCE_QUERIES.decemberCheckout);
    expect(validateSql(sql)).toBe(sql.trim());
  });

  it.each(Object.entries(REFERENCE_QUERIES))("accepts reference %s", (_, sql) => {
    expect(validateSql(sql)).toBe(sql.trim());
  });
  it.each([
    bounded,
    `WITH x AS (${bounded}) SELECT n FROM x`,
    `SELECT n FROM (${bounded}) x`,
    `SELECT (SELECT MAX(value.int_value) FROM UNNEST(event_params) WHERE key='ga_session_id') AS session_id FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    `SELECT parameter.key, COUNT(*) AS occurrences FROM ${table} CROSS JOIN UNNEST(event_params) AS parameter WHERE _TABLE_SUFFIX BETWEEN '20201201' AND '20201231' GROUP BY parameter.key`,
    `${bounded} UNION ALL ${bounded}`,
    `SELECT COUNT(*) FROM ${table} e WHERE e._TABLE_SUFFIX >= '20201201' AND e._TABLE_SUFFIX <= '20201231'`,
    `SELECT COUNT(*) FROM ${table} a JOIN ${table} b ON a.user_pseudo_id=b.user_pseudo_id WHERE a._TABLE_SUFFIX='20201201' AND b._TABLE_SUFFIX='20201202'`,
    "SELECT COUNT(*) FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20201201`",
  ])("accepts supported structures: %s", sql => expect(() => validateSql(sql)).not.toThrow());

  it.each([
    "DELETE FROM x", `${bounded}; DELETE FROM x`, `${bounded}; SELECT 1`,
    `WITH x AS (SELECT 1 FROM foreign_project.data.table) SELECT 1 FROM x`,
    `SELECT (SELECT 1 FROM foreign_project.data.table) FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    `WITH events_20201201 AS (SELECT 1 FROM foreign_project.data.table) SELECT 1 FROM events_20201201`,
    `WITH x AS (${bounded}) SELECT 1 FROM (WITH x AS (SELECT 1 FROM foreign_project.data.table) SELECT 1 FROM x)`,
    `WITH x AS (SELECT n FROM x) SELECT 1 FROM x`,
    `${bounded} UNION ALL SELECT 1 FROM foreign_project.data.table`,
    `WITH x AS (${bounded}) SELECT x.n FROM x JOIN x y ON EXISTS(SELECT 1 FROM foreign_project.data.table)`,
    `SELECT COUNT(*) FROM ${table}`,
    `SELECT COUNT(*) FROM ${table} WHERE _TABLE_SUFFIX='20201201' OR TRUE`,
    `SELECT COUNT(*) FROM ${table} WHERE NOT (_TABLE_SUFFIX='20201201')`,
    `SELECT COUNT(*) FROM ${table} WHERE _TABLE_SUFFIX BETWEEN '20201101' AND '20210201'`,
    `SELECT COUNT(*) FROM ${table} WHERE _TABLE_SUFFIX='20201131'`,
    `SELECT COUNT(*) FROM ${table} WHERE _TABLE_SUFFIX BETWEEN '20201231' AND '20201201'`,
    `SELECT COUNT(*) FROM ${table} WHERE _TABLE_SUFFIX>= '20201201'`,
    `SELECT COUNT(*) FROM ${table} a JOIN ${table} b ON TRUE WHERE a._TABLE_SUFFIX='20201201'`,
    `SELECT COUNT(*) FROM ${table} e JOIN ${table} e ON TRUE WHERE e._TABLE_SUFFIX='20201201'`,
    `SELECT COUNT(*) FROM ${table} e JOIN (${bounded}) b ON TRUE WHERE _TABLE_SUFFIX='20201201'`,
    `SELECT foreign_project.dataset.fn(1) FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    "SELECT * FROM EXTERNAL_QUERY('connection', 'SELECT 1')",
    `SELECT * FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    `SELECT e.* FROM ${table} e WHERE _TABLE_SUFFIX='20201201'`,
    "SELECT COUNT(*) FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_20210201`",
    "WITH RECURSIVE x AS (SELECT 1) SELECT 1 FROM x",
    `SELECT ROW_NUMBER() OVER() FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    `SELECT REGEXP_EXTRACT(event_name,'x') FROM ${table} WHERE _TABLE_SUFFIX='20201201'`,
    "this is not SQL", "", "x".repeat(32769),
  ])("rejects forbidden or unsupported SQL: %s", sql => expect(() => validateSql(sql)).toThrow());
});
