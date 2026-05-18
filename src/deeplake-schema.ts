/**
 * Single source of truth for the Deeplake table schemas this plugin owns.
 *
 * Each table is described as an array of `{ name, sql }` entries. Both
 * `CREATE TABLE` and lazy schema healing iterate over the same list, so
 * adding a new column means one edit here — no second mirror in the
 * ensure / ALTER paths to keep in sync.
 *
 * Healing rules (do not hand-roll the flow elsewhere — call
 * `healMissingColumns` below):
 *   1. One SELECT against `information_schema.columns` per table to read
 *      the current column set.
 *   2. Diff against the schema definition.
 *   3. `ALTER TABLE ADD COLUMN` only the genuinely missing columns —
 *      never blanket, never `IF NOT EXISTS`. The single tolerated race
 *      ("already exists" from a concurrent writer) is caught and
 *      re-verified with a second SELECT.
 *
 * Background: a historical Deeplake post-ALTER bug (a ~30s window of
 * failing INSERTs after every ALTER) motivated a marker-cached
 * "ensureColumn" path. The bug was re-probed against `api.deeplake.ai`
 * on 2026-05-18 in the `test_plugin` org and is no longer reproducible
 * (71/71 INSERTs OK, first success 2ms after ALTER). The SELECT-first
 * rule survives anyway because each ALTER still costs ~800ms and a
 * targeted diff produces clearer logs than a blanket sweep.
 */

import { sqlIdent, sqlStr } from "./utils/sql.js";

export interface ColumnDef {
  /** Bare column identifier, e.g. `contributors`. */
  name: string;
  /** Column SQL minus the name, e.g. `TEXT NOT NULL DEFAULT '[]'`. */
  sql: string;
}

// ── Schema definitions ──────────────────────────────────────────────────────

/** Memory table — wiki summaries written by the SessionStart workers. */
export const MEMORY_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id",                sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path",              sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename",          sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary",           sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary_embedding", sql: "FLOAT4[]" },
  { name: "author",            sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type",         sql: "TEXT NOT NULL DEFAULT 'text/plain'" },
  { name: "size_bytes",        sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project",           sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description",       sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent",             sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version",    sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date",     sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date",  sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** Sessions table — raw per-turn agent events. */
export const SESSIONS_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id",                sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path",              sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename",          sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "message",           sql: "JSONB" },
  { name: "message_embedding", sql: "FLOAT4[]" },
  { name: "author",            sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type",         sql: "TEXT NOT NULL DEFAULT 'application/json'" },
  { name: "size_bytes",        sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project",           sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description",       sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent",             sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version",    sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date",     sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date",  sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** Skills table — one row per skill version. */
export const SKILLS_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id",              sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "name",            sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project",         sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project_key",     sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "local_path",      sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "install",         sql: "TEXT NOT NULL DEFAULT 'project'" },
  { name: "source_sessions", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "source_agent",    sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "scope",           sql: "TEXT NOT NULL DEFAULT 'me'" },
  { name: "author",          sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "contributors",    sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "description",     sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "trigger_text",    sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "body",            sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version",         sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at",      sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at",      sql: "TEXT NOT NULL DEFAULT ''" },
]);

// ── Module-load lint ────────────────────────────────────────────────────────

/**
 * `ALTER TABLE ADD COLUMN <name> NOT NULL` on a populated table fails
 * unless a DEFAULT is provided (the backend needs something to backfill
 * existing rows with). Catch this at module-load time so a missing
 * DEFAULT can't sneak into a schema definition and break healing in
 * production. Nullable columns (no NOT NULL) are exempt: NULL is their
 * implicit default and the backfill is trivial.
 */
function validateSchema(label: string, cols: readonly ColumnDef[]): void {
  const seen = new Set<string>();
  for (const col of cols) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name)) {
      throw new Error(`${label}: column name "${col.name}" is not a valid SQL identifier`);
    }
    if (seen.has(col.name)) {
      throw new Error(`${label}: duplicate column "${col.name}"`);
    }
    seen.add(col.name);
    const notNull = /\bNOT\s+NULL\b/i.test(col.sql);
    const hasDefault = /\bDEFAULT\b/i.test(col.sql);
    if (notNull && !hasDefault) {
      throw new Error(
        `${label}: column "${col.name}" is NOT NULL but has no DEFAULT — ` +
        `ALTER TABLE ADD COLUMN on a populated table would fail.`,
      );
    }
  }
}

validateSchema("MEMORY_COLUMNS", MEMORY_COLUMNS);
validateSchema("SESSIONS_COLUMNS", SESSIONS_COLUMNS);
validateSchema("SKILLS_COLUMNS", SKILLS_COLUMNS);

// ── SQL builders ────────────────────────────────────────────────────────────

/** Render a `CREATE TABLE IF NOT EXISTS … USING deeplake` from a column list. */
export function buildCreateTableSql(tableName: string, cols: readonly ColumnDef[]): string {
  const safe = sqlIdent(tableName);
  const colSql = cols.map(c => `${c.name} ${c.sql}`).join(", ");
  return `CREATE TABLE IF NOT EXISTS "${safe}" (${colSql}) USING deeplake`;
}

/** Render a `SELECT column_name` against `information_schema.columns`. */
function buildIntrospectionSql(tableName: string, workspaceId: string): string {
  return (
    `SELECT column_name FROM information_schema.columns ` +
    `WHERE table_name = '${sqlStr(tableName)}' ` +
    `AND table_schema = '${sqlStr(workspaceId)}'`
  );
}

// ── Healing primitive shared by API client and worker ───────────────────────

export type QueryFn = (sql: string) => Promise<unknown>;

/** Outcome of a `healMissingColumns` pass. */
export interface HealResult {
  /**
   * Columns the introspection SELECT determined were missing from the table.
   * Empty when the table already matched the schema. Useful for distinguishing
   * "schema was up-to-date" from "the ALTER pass ran but lost every race",
   * which look the same if you only look at `altered`.
   */
  missing: string[];
  /**
   * Columns this call actually ALTERed in. A subset of `missing`. The
   * difference (`missing` items not in `altered`) is where the ALTER hit
   * an "already exists" race and was re-verified as no-op.
   */
  altered: string[];
}

/**
 * Add missing columns to `tableName` so it matches `cols`. One SELECT
 * against `information_schema.columns` reads the current set, then we
 * `ALTER TABLE ADD COLUMN` only the truly missing ones. Race with a
 * concurrent writer ("already exists") is caught and re-verified.
 *
 * Caller decides when to invoke. Suggested triggers:
 *   - long-lived API client: once per process per table (e.g. on
 *     SessionStart), wrapped in your own dedup if you want zero-cost
 *     no-ops across many calls;
 *   - short-lived worker: only inside the catch of an INSERT that
 *     failed with a missing-column error.
 *
 * Returns both `missing` (what the diff said) and `altered` (what we
 * actually ran). A worker can use `missing.length === 0` to decide that
 * the error came from a column outside the schema's knowledge and
 * propagate the original error rather than retrying.
 */
export async function healMissingColumns(args: {
  query: QueryFn;
  tableName: string;
  workspaceId: string;
  columns: readonly ColumnDef[];
  /** Optional logger for `[schema-heal] …` lines. */
  log?: (msg: string) => void;
}): Promise<HealResult> {
  const safeTable = sqlIdent(args.tableName);
  const introspectSql = buildIntrospectionSql(args.tableName, args.workspaceId);

  const rows = (await args.query(introspectSql)) as Array<Record<string, unknown>>;
  const existing = new Set<string>();
  for (const row of rows) {
    // Deeplake returns either { column_name: "x" } or positional rows
    // wrapped to objects by the API client. Both shapes carry the same key.
    const v = row?.column_name;
    if (typeof v === "string") existing.add(v.toLowerCase());
  }

  const missingCols = args.columns.filter(c => !existing.has(c.name.toLowerCase()));
  const missing = missingCols.map(c => c.name);
  if (missingCols.length === 0) return { missing, altered: [] };

  const altered: string[] = [];
  for (const col of missingCols) {
    try {
      await args.query(`ALTER TABLE "${safeTable}" ADD COLUMN ${col.name} ${col.sql}`);
      altered.push(col.name);
      args.log?.(`schema-heal: added "${args.tableName}"."${col.name}"`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) throw e;
      // Race: a concurrent writer added the column between our SELECT and
      // our ALTER. Re-verify before treating as success — any other shape
      // of "already exists" (e.g. a same-named column with the wrong type
      // we did not put there) should not be silently swallowed.
      const recheck = (await args.query(introspectSql)) as Array<Record<string, unknown>>;
      const present = recheck.some(r => {
        const v = r?.column_name;
        return typeof v === "string" && v.toLowerCase() === col.name.toLowerCase();
      });
      if (!present) throw e;
      args.log?.(`schema-heal: "${args.tableName}"."${col.name}" appeared via race, treating as success`);
    }
  }
  return { missing, altered };
}

// ── Error classification (shared by worker INSERT retry) ────────────────────

/**
 * Match the wording Deeplake / Postgres emit when the *table itself*
 * is missing. Excludes "permission denied" and missing-column variants
 * — those route to different recovery branches.
 */
export function isMissingTableError(message: string | undefined): boolean {
  if (!message) return false;
  if (/permission denied|must be owner/i.test(message)) return false;
  // Postgres' missing-column shape includes `relation "x" does not exist`
  // as a substring of `column "y" of relation "x" does not exist`, so any
  // mention of `column` routes to the column branch instead.
  if (/\bcolumn\b/i.test(message)) return false;
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}

/**
 * Match the wording Deeplake / Postgres emit when *any column* is
 * missing on a write. Used by short-lived workers to decide whether to
 * run a heal pass before retrying the INSERT.
 */
export function isMissingColumnError(message: string | undefined): boolean {
  if (!message) return false;
  if (/permission denied|must be owner/i.test(message)) return false;
  return (
    /column ["']?[A-Za-z_][A-Za-z0-9_]*["']? .*does not exist/i.test(message) ||
    /unknown column/i.test(message) ||
    /no such column/i.test(message)
  );
}
