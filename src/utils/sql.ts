/**
 * SQL escaping utilities for Deeplake SQL API.
 *
 * The Deeplake HTTP query endpoint does not support parameterized queries,
 * so we must escape values carefully before interpolation.
 */

/**
 * Escape a string value for use inside a SQL single-quoted literal.
 * Handles: single quotes, backslashes, NUL bytes, and control characters.
 */
export function sqlStr(value: string): string {
  return value
    .replace(/\\/g, "\\\\")          // backslashes before quotes
    .replace(/'/g, "''")              // single-quote escape (standard SQL)
    .replace(/\0/g, "")              // NUL bytes — reject entirely
    .replace(/[\x01-\x1f\x7f]/g, ""); // other control characters
}

/**
 * Escape a string for use inside a SQL LIKE/ILIKE pattern.
 * In addition to sqlStr escaping, also escapes the LIKE wildcards % and _.
 */
export function sqlLike(value: string): string {
  return sqlStr(value)
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Validate and return a safe SQL identifier (table or column name).
 * Only allows alphanumeric characters and underscores.
 * Throws if the name is invalid to prevent identifier injection.
 */
export function sqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Validate a numeric value for use in SQL without quoting.
 * Throws if the value is not a safe finite integer or float.
 */
export function sqlNum(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid SQL number: ${value}`);
  return n;
}
