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
export declare function sqlStr(value: string): string;
/**
 * Escape a string for use inside a SQL LIKE/ILIKE pattern.
 */
export declare function sqlLike(value: string): string;
/**
 * Validate and return a safe SQL identifier (table or column name).
 */
export declare function sqlIdent(name: string): string;
