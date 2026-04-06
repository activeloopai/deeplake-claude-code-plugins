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
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Escape a string for use inside a SQL LIKE/ILIKE pattern.
 */
export function sqlLike(value: string): string {
  return sqlStr(value)
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Validate and return a safe SQL identifier (table or column name).
 */
export function sqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}
