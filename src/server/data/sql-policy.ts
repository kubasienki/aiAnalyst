import { Parser } from "node-sql-parser";
import { DataQueryError } from "./errors";

type SqlNode = Record<string, unknown>;
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

function asNode(value: unknown): SqlNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataQueryError("unsupported_sql", "Unsupported SQL structure.");
  }
  return value as SqlNode;
}

function readIdentifier(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const astNode = asNode(value);
    if (typeof astNode.value === "string") {
      return astNode.value;
    }
    if (astNode.expr) {
      return readIdentifier(astNode.expr);
    }
  }
  return "";
}

function isAvailableDate(value: string): boolean {
  if (!/^\d{8}$/.test(value) || value < "20201101" || value > "20210131") {
    return false;
  }
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

function readLiteralDate(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return;
  }
  const astNode = asNode(value);
  if (astNode.type !== "single_quote_string" || typeof astNode.value !== "string") {
    return;
  }
  return isAvailableDate(astNode.value) ? astNode.value : undefined;
}

function mandatoryConditions(value: unknown): SqlNode[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const astNode = asNode(value);
  // Only top-level AND terms establish mandatory bounds; OR and NOT do not.
  if (astNode.type === "binary_expr" && astNode.operator === "AND") {
    return [...mandatoryConditions(astNode.left), ...mandatoryConditions(astNode.right)];
  }
  return [astNode];
}

function hasDateBound(where: unknown, alias: string | null, allowUnqualified: boolean): boolean {
  let lower: string | undefined;
  let upper: string | undefined;
  for (const condition of mandatoryConditions(where)) {
    if (condition.type !== "binary_expr" || !condition.left) {
      continue;
    }
    const left = asNode(condition.left);
    if (left.type !== "column_ref" || readIdentifier(left.column).toUpperCase() !== "_TABLE_SUFFIX") {
      continue;
    }
    // Subfields/offsets are expressions rather than the source pseudocolumn itself.
    if (Array.isArray(left.subFields) && left.subFields.length) {
      continue;
    }
    if (left.column && typeof left.column === "object") {
      const offsets = asNode(left.column).offset;
      if (Array.isArray(offsets) && offsets.length) {
        continue;
      }
    }
    const qualifier = readIdentifier(left.table).toLowerCase();
    if (qualifier ? qualifier !== alias : !allowUnqualified) {
      continue;
    }
    if (condition.operator === "BETWEEN") {
      const values = asNode(condition.right).value;
      if (!Array.isArray(values) || values.length !== 2) {
        continue;
      }
      const from = readLiteralDate(values[0]);
      const to = readLiteralDate(values[1]);
      if (from && to && from <= to) {
        return true;
      }
    }
    const date = readLiteralDate(condition.right);
    if (!date) {
      continue;
    }
    if (condition.operator === "=") {
      return true;
    }
    if (condition.operator === ">=" && (!lower || date > lower)) {
      lower = date;
    }
    if (condition.operator === "<=" && (!upper || date < upper)) {
      upper = date;
    }
  }
  return Boolean(lower && upper && lower <= upper);
}

function validateExpression(astNode: SqlNode): void {
  if (typeof astNode.type === "string" && !EXPRESSION_TYPES.has(astNode.type)) {
    throw new DataQueryError("unsupported_sql", "SQL uses an unsupported expression.");
  }
  if (astNode.type === "function" || astNode.type === "aggr_func") {
    let name = readIdentifier(astNode.name);
    if (typeof astNode.name === "object") {
      const functionName = asNode(astNode.name);
      if (!Array.isArray(functionName.name) || functionName.name.length) {
        throw new DataQueryError("rejected_sql", "Qualified routines are not allowed.");
      }
      name = readIdentifier(functionName.schema);
    }
    if (!FUNCTIONS.has(name.toUpperCase())) {
      throw new DataQueryError("unsupported_sql", "Function is not in the supported built-in allowlist.");
    }
  }
  if (astNode.over) {
    throw new DataQueryError("unsupported_sql", "Window functions are outside the initial SQL subset.");
  }
}

function validateProjections(select: SqlNode): void {
  if (!Array.isArray(select.columns)) {
    throw new DataQueryError("rejected_sql", "Select explicit columns instead of SELECT *.");
  }
  for (const entry of select.columns) {
    const expression = asNode(asNode(entry).expr);
    if (expression.type === "star" || (expression.type === "column_ref" && readIdentifier(expression.column) === "*")) {
      throw new DataQueryError("rejected_sql", "Select explicit columns instead of projection wildcards.");
    }
  }
}

function validateTableClause(source: SqlNode): void {
  const allowedKeys = new Set([
    "db", "table", "surround", "as", "operator", "join", "on", "using", "parentheses",
  ]);
  if (Object.keys(source).some(key => !allowedKeys.has(key))) {
    throw new DataQueryError("unsupported_sql", "Unsupported table clause.");
  }
}

function validateEventTable(
  source: SqlNode,
  where: unknown,
  alias: string | null,
  allowUnqualified: boolean,
): void {
  const table = source.table;
  if (source.db || typeof table !== "string" || !table.startsWith(SOURCE)) {
    throw new DataQueryError("rejected_sql", "Only the public GA4 event tables are allowed.");
  }
  const suffix = table.slice(SOURCE.length);
  if (suffix === "*") {
    if (!hasDateBound(where, alias, allowUnqualified)) {
      throw new DataQueryError("rejected_sql", "Each wildcard scan needs a mandatory literal _TABLE_SUFFIX range within available dates.");
    }
  } else if (!isAvailableDate(suffix)) {
    throw new DataQueryError("rejected_sql", "Event table date is outside the available period.");
  }
}

export function validateSql(sql: unknown): string {
  if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql, "utf8") > 32 * 1024) {
    throw new DataQueryError("invalid_input", "SQL must be nonempty and at most 32 KiB.");
  }
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: "BigQuery" });
  } catch {
    throw new DataQueryError("unsupported_sql", "SQL could not be parsed in the supported BigQuery subset.");
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      throw new DataQueryError("rejected_sql", "Only one SELECT statement is allowed.");
    }
    ast = ast[0];
  }
  let physicalSourceCount = 0;
  let visitedNodeCount = 0;

  function walk(value: unknown, scope: Set<string>, depth = 0): void {
    if (!value || typeof value !== "object") {
      return;
    }
    if (++visitedNodeCount > 10000 || depth > 100) {
      throw new DataQueryError("unsupported_sql", "SQL is too complex.");
    }
    if (Array.isArray(value)) {
      value.forEach(child => walk(child, scope, depth + 1));
      return;
    }
    const astNode = asNode(value);
    if (astNode.type === "select") {
      inspectSelect(astNode, scope, depth + 1);
      return;
    }
    validateExpression(astNode);
    for (const [key, child] of Object.entries(astNode)) {
      if (!["tableList", "columnList", "loc"].includes(key)) {
        walk(child, scope, depth + 1);
      }
    }
  }

  function inspectSelect(select: SqlNode, inherited: Set<string>, depth: number): void {
    if (select.into || select.for_sys_time_as_of || select.window || select.recursive) {
      throw new DataQueryError("rejected_sql", "SELECT uses a prohibited clause.");
    }
    const scope = new Set(inherited);
    const declared = new Set<string>();
    for (const entry of (select.with as unknown[] | null) || []) {
      const cte = asNode(entry);
      const name = readIdentifier(cte.name).toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(name) || declared.has(name)) {
        throw new DataQueryError("unsupported_sql", "CTE names must be unique simple identifiers.");
      }
      // Validate before binding the name: recursive/self references cannot hide sources.
      walk(cte.stmt, scope, depth + 1);
      declared.add(name);
      scope.add(name);
    }
    validateProjections(select);
    const sources = (select.from as unknown[] | null) || [];
    const physicalTables = sources.map(asNode).filter(source =>
      typeof source.table === "string" && !scope.has(source.table.toLowerCase()),
    );
    const allowUnqualified = physicalTables.length === 1 && sources.every(entry => {
      const source = asNode(entry);
      return source === physicalTables[0] || source.type === "unnest";
    });
    const aliases = new Set<string>();
    for (const entry of sources) {
      const source = asNode(entry);
      walk(source.on, scope, depth + 1);
      const alias = typeof source.as === "string" ? source.as.toLowerCase() : null;
      if (alias) {
        if (aliases.has(alias)) {
          throw new DataQueryError("rejected_sql", "Source aliases must be unique.");
        }
        aliases.add(alias);
      }
      if (typeof source.table === "string") {
        validateTableClause(source);
        if (scope.has(source.table.toLowerCase()) && !source.db) {
          continue;
        }
        validateEventTable(source, select.where, alias, allowUnqualified);
        physicalSourceCount++;
      } else if (source.type === "unnest") {
        if (asNode(source.expr).type !== "column_ref") {
          throw new DataQueryError("unsupported_sql", "UNNEST must expand an existing array column.");
        }
        walk(source.expr, scope, depth + 1);
      } else if (source.expr && asNode(source.expr).ast) {
        walk(source.expr, scope, depth + 1);
      } else {
        throw new DataQueryError("unsupported_sql", "Unsupported FROM source.");
      }
    }
    for (const [key, value] of Object.entries(select)) {
      if (!["with", "from"].includes(key)) {
        walk(value, scope, depth + 1);
      }
    }
  }

  if (asNode(ast).type !== "select") {
    throw new DataQueryError("rejected_sql", "Only SELECT statements are allowed.");
  }
  walk(ast, new Set());
  if (!physicalSourceCount) {
    throw new DataQueryError("rejected_sql", "Query must read the public GA4 event tables.");
  }
  return sql.trim();
}
