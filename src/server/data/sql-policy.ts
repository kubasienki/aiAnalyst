import { Parser } from "node-sql-parser";
import { DataQueryError } from "./errors";

type Node = Record<string, unknown>;
const parser = new Parser();
const SOURCE = "bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_";
const FUNCTIONS = new Set([
  "COUNT", "COUNTIF", "SUM", "AVG", "MIN", "MAX", "IF", "IFNULL", "NULLIF", "COALESCE",
  "SAFE_DIVIDE", "ABS", "ROUND", "CEIL", "FLOOR", "GREATEST", "LEAST",
  "SUBSTR", "SUBSTRING", "LOWER", "UPPER", "TRIM", "CONCAT", "LENGTH",
  "DATE", "DATE_TRUNC", "DATE_DIFF", "FORMAT_DATE", "PARSE_DATE", "EXTRACT",
  "TIMESTAMP_MICROS", "TIMESTAMP_SECONDS", "ARRAY_LENGTH",
]);
const EXPRESSION_TYPES = new Set([
  "column_ref", "binary_expr", "unary_expr", "expr_list", "function", "aggr_func",
  "cast", "case", "when", "else", "number", "bool", "null", "default",
  "single_quote_string", "double_quote_string", "string", "star", "ASC", "DESC",
]);

function node(value: unknown): Node {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataQueryError("unsupported_sql", "Unsupported SQL structure.");
  }
  return value as Node;
}

function identifier(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const n = node(value);
    if (typeof n.value === "string") return n.value;
    if (n.expr) return identifier(n.expr);
  }
  return "";
}

function validDate(value: string): boolean {
  if (!/^\d{8}$/.test(value) || value < "20201101" || value > "20210131") return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

function literalDate(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const n = node(value);
  if (n.type !== "single_quote_string" || typeof n.value !== "string") return;
  return validDate(n.value) ? n.value : undefined;
}

function conjuncts(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  const n = node(value);
  return n.type === "binary_expr" && n.operator === "AND"
    ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n];
}

function hasDateBound(where: unknown, alias: string | null, allowUnqualified: boolean): boolean {
  let lower: string | undefined;
  let upper: string | undefined;
  for (const condition of conjuncts(where)) {
    if (condition.type !== "binary_expr" || !condition.left) continue;
    const left = node(condition.left);
    if (left.type !== "column_ref" || identifier(left.column).toUpperCase() !== "_TABLE_SUFFIX") continue;
    // Subfields/offsets are expressions rather than the source pseudocolumn itself.
    if (Array.isArray(left.subFields) && left.subFields.length) continue;
    if (left.column && typeof left.column === "object" && node(left.column).offset instanceof Array && (node(left.column).offset as unknown[]).length) continue;
    const qualifier = identifier(left.table).toLowerCase();
    if (qualifier ? qualifier !== alias : !allowUnqualified) continue;
    if (condition.operator === "BETWEEN") {
      const values = node(condition.right).value;
      if (!Array.isArray(values) || values.length !== 2) continue;
      const from = literalDate(values[0]);
      const to = literalDate(values[1]);
      if (from && to && from <= to) return true;
    }
    const date = literalDate(condition.right);
    if (!date) continue;
    if (condition.operator === "=") return true;
    if (condition.operator === ">=") lower = lower && lower > date ? lower : date;
    if (condition.operator === "<=") upper = upper && upper < date ? upper : date;
  }
  return Boolean(lower && upper && lower <= upper);
}

export function validateSql(sql: unknown): string {
  if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql, "utf8") > 32 * 1024) {
    throw new DataQueryError("invalid_input", "SQL must be nonempty and at most 32 KiB.");
  }
  let ast: unknown;
  try { ast = parser.astify(sql, { database: "BigQuery" }); }
  catch { throw new DataQueryError("unsupported_sql", "SQL could not be parsed in the supported BigQuery subset."); }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) throw new DataQueryError("rejected_sql", "Only one SELECT statement is allowed.");
    ast = ast[0];
  }
  let physicalSources = 0;
  let visited = 0;

  function walk(value: unknown, scope: Set<string>, depth = 0): void {
    if (!value || typeof value !== "object") return;
    if (++visited > 10000 || depth > 100) throw new DataQueryError("unsupported_sql", "SQL is too complex.");
    if (Array.isArray(value)) { value.forEach(v => walk(v, scope, depth + 1)); return; }
    const n = node(value);
    if (n.type === "select") { inspectSelect(n, scope, depth + 1); return; }
    if (typeof n.type === "string" && !EXPRESSION_TYPES.has(n.type)) {
      throw new DataQueryError("unsupported_sql", "SQL uses an unsupported expression.");
    }
    if (n.type === "function" || n.type === "aggr_func") {
      let name = identifier(n.name);
      if (typeof n.name === "object") {
        const fn = node(n.name);
        if (!Array.isArray(fn.name) || fn.name.length) {
          throw new DataQueryError("rejected_sql", "Qualified routines are not allowed.");
        }
        name = identifier(fn.schema);
      }
      if (!FUNCTIONS.has(name.toUpperCase())) throw new DataQueryError("unsupported_sql", "Function is not in the supported built-in allowlist.");
    }
    if (n.over) throw new DataQueryError("unsupported_sql", "Window functions are outside the initial SQL subset.");
    for (const [key, child] of Object.entries(n)) {
      if (!["tableList", "columnList", "loc"].includes(key)) walk(child, scope, depth + 1);
    }
  }

  function inspectSelect(select: Node, inherited: Set<string>, depth: number): void {
    if (select.into || select.for_sys_time_as_of || select.window || select.recursive) {
      throw new DataQueryError("rejected_sql", "SELECT uses a prohibited clause.");
    }
    const scope = new Set(inherited);
    const declared = new Set<string>();
    for (const entry of (select.with as unknown[] | null) || []) {
      const cte = node(entry);
      const name = identifier(cte.name).toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(name) || declared.has(name)) {
        throw new DataQueryError("unsupported_sql", "CTE names must be unique simple identifiers.");
      }
      // Validate before binding the name: recursive/self references cannot hide sources.
      walk(cte.stmt, scope, depth + 1);
      declared.add(name);
      scope.add(name);
    }
    if (!Array.isArray(select.columns)) throw new DataQueryError("rejected_sql", "Select explicit columns instead of SELECT *.");
    for (const entry of select.columns) {
      const expr = node(node(entry).expr);
      if (expr.type === "star" || (expr.type === "column_ref" && identifier(expr.column) === "*")) {
        throw new DataQueryError("rejected_sql", "Select explicit columns instead of projection wildcards.");
      }
    }
    const sources = (select.from as unknown[] | null) || [];
    const physical = sources.map(node).filter(s => typeof s.table === "string" && !scope.has(String(s.table).toLowerCase()));
    const allowUnqualified = physical.length === 1 && sources.every(s => {
      const n = node(s);
      return n === physical[0] || n.type === "unnest";
    });
    const aliases = new Set<string>();
    for (const entry of sources) {
      const source = node(entry);
      walk(source.on, scope, depth + 1);
      const alias = typeof source.as === "string" ? source.as.toLowerCase() : null;
      if (alias) {
        if (aliases.has(alias)) throw new DataQueryError("rejected_sql", "Source aliases must be unique.");
        aliases.add(alias);
      }
      if (typeof source.table === "string") {
        const sourceKeys = new Set(["db", "table", "surround", "as", "operator", "join", "on", "using", "parentheses"]);
        if (Object.keys(source).some(key => !sourceKeys.has(key))) {
          throw new DataQueryError("unsupported_sql", "Unsupported table clause.");
        }
        if (scope.has(source.table.toLowerCase()) && !source.db) continue;
        if (source.db || !source.table.startsWith(SOURCE)) throw new DataQueryError("rejected_sql", "Only the public GA4 event tables are allowed.");
        const suffix = source.table.slice(SOURCE.length);
        if (suffix === "*") {
          if (!hasDateBound(select.where, alias, allowUnqualified)) {
            throw new DataQueryError("rejected_sql", "Each wildcard scan needs a mandatory literal _TABLE_SUFFIX range within available dates.");
          }
        } else if (!validDate(suffix)) throw new DataQueryError("rejected_sql", "Event table date is outside the available period.");
        physicalSources++;
      } else if (source.type === "unnest") {
        if (node(source.expr).type !== "column_ref") throw new DataQueryError("unsupported_sql", "UNNEST must expand an existing array column.");
        walk(source.expr, scope, depth + 1);
      } else if (source.expr && node(source.expr).ast) {
        walk(source.expr, scope, depth + 1);
      } else throw new DataQueryError("unsupported_sql", "Unsupported FROM source.");
    }
    for (const [key, value] of Object.entries(select)) {
      if (!["with", "from"].includes(key)) walk(value, scope, depth + 1);
    }
  }

  if (node(ast).type !== "select") throw new DataQueryError("rejected_sql", "Only SELECT statements are allowed.");
  walk(ast, new Set());
  if (!physicalSources) throw new DataQueryError("rejected_sql", "Query must read the public GA4 event tables.");
  return sql.trim();
}
