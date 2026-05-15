import { randomUUID } from "node:crypto";
import { sqlIdent } from "../utils/sql.js";

/**
 * SQL to create the `skills` table. Mirror of ensureSkillsTable() in
 * deeplake-api.ts — kept inline so the worker can run it via its own
 * query() fn on first-INSERT-fails-because-missing, without dragging the
 * full DeeplakeApi class into the worker bundle.
 */
export function createSkillsTableSql(tableName: string): string {
  // sqlIdent throws on anything outside [A-Za-z_][A-Za-z0-9_]* — protects
  // against HIVEMIND_SKILLS_TABLE config injection (a stray quote would
  // otherwise break CREATE TABLE / CREATE INDEX startup).
  const safe = sqlIdent(tableName);
  return (
    `CREATE TABLE IF NOT EXISTS "${safe}" (` +
      `id TEXT NOT NULL DEFAULT '', ` +
      `name TEXT NOT NULL DEFAULT '', ` +
      `project TEXT NOT NULL DEFAULT '', ` +
      `project_key TEXT NOT NULL DEFAULT '', ` +
      `local_path TEXT NOT NULL DEFAULT '', ` +
      `install TEXT NOT NULL DEFAULT 'project', ` +
      `source_sessions TEXT NOT NULL DEFAULT '[]', ` +
      `source_agent TEXT NOT NULL DEFAULT '', ` +
      `scope TEXT NOT NULL DEFAULT 'me', ` +
      `author TEXT NOT NULL DEFAULT '', ` +
      // JSON array, e.g. ["alice","emanuele"]. Ordered chronologically by
      // edit. Issue #118: lets the gate track cross-author edits and
      // auto-promote scope=me -> scope=team when the editor != author.
      `contributors TEXT NOT NULL DEFAULT '[]', ` +
      `description TEXT NOT NULL DEFAULT '', ` +
      `trigger_text TEXT NOT NULL DEFAULT '', ` +
      `body TEXT NOT NULL DEFAULT '', ` +
      `version BIGINT NOT NULL DEFAULT 1, ` +
      `created_at TEXT NOT NULL DEFAULT '', ` +
      `updated_at TEXT NOT NULL DEFAULT ''` +
    `) USING deeplake`
  );
}

/**
 * SQL to add the `contributors` column to a table that pre-dates the
 * column. Runs lazily on first INSERT-fails-because-column-missing, so
 * existing deployments keep working without an explicit migration step.
 */
export function addContributorsColumnSql(tableName: string): string {
  const safe = sqlIdent(tableName);
  return `ALTER TABLE "${safe}" ADD COLUMN IF NOT EXISTS contributors TEXT NOT NULL DEFAULT '[]'`;
}

/**
 * Insert one row into the Deeplake `skills` table per skill version.
 *
 * Append-only: every KEEP/MERGE writes a fresh row. The most recent row for
 * (project_key, name) is the current state — readers ORDER BY version DESC
 * LIMIT 1. This avoids the UPDATE-coalescing quirk that hit the wiki worker
 * (CLAUDE.md: two rapid UPDATEs on the same row drop one silently).
 */

export interface InsertSkillRowArgs {
  /** Async SQL executor (the worker's own `query` fn, the API client, or a test mock). */
  query: (sql: string) => Promise<unknown>;
  tableName: string;
  /** Skill metadata. */
  name: string;
  project: string;
  projectKey: string;
  localPath: string;
  install: "project" | "global";
  sourceSessions: string[];
  sourceAgent: string;
  scope: "me" | "team";
  author: string;
  /**
   * Editors in chronological order, including the original author as the
   * first entry. Persisted as a JSON-encoded string in the `contributors`
   * column. Empty array is valid (legacy callers) and round-trips through
   * the table; readers fall back to `[author]` when they see it.
   */
  contributors: string[];
  description: string;
  trigger?: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Pre-generated UUID for this row. Pass an existing one for testing. */
  id?: string;
}

/** Escape a string for use inside a SQL single-quoted literal. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isMissingTableError(message: string | undefined): boolean {
  if (!message) return false;
  // Match phrases that unambiguously indicate "the table itself isn't there".
  // Notably we do NOT treat 'permission denied' as missing-table — it's a
  // different problem (auth scope) and re-running CREATE TABLE wouldn't help.
  //
  // Postgres' missing-column error includes `relation "x" does not exist`
  // as part of `column "y" of relation "x" does not exist`, which would
  // otherwise false-match the second alternative below. Discriminate by
  // bailing out when the word "column" appears anywhere in the message —
  // a column-level error should route to isMissingContributorsColumnError
  // (or rethrow), not to the CREATE TABLE retry.
  if (/\bcolumn\b/i.test(message)) return false;
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}

/**
 * Recognises errors the backend emits when the `contributors` column is
 * missing — typically deployments that predate this column. Narrow on
 * purpose: we only want to react to "this column doesn't exist", not
 * other 400s. Tested against both Deeplake's wording and Postgres'
 * (`column "contributors" of relation "skills" does not exist`).
 */
function isMissingContributorsColumnError(message: string | undefined): boolean {
  if (!message) return false;
  return /contributors.*(?:does not exist|not found|unknown)/i.test(message)
    || /(?:does not exist|unknown column).*contributors/i.test(message);
}

export async function insertSkillRow(args: InsertSkillRowArgs): Promise<void> {
  const id = args.id ?? randomUUID();
  const sourceSessionsJson = JSON.stringify(args.sourceSessions);
  const contributorsJson = JSON.stringify(args.contributors);
  const sql =
    `INSERT INTO "${sqlIdent(args.tableName)}" (` +
      `id, name, project, project_key, local_path, install, ` +
      `source_sessions, source_agent, scope, author, contributors, ` +
      `description, trigger_text, body, version, created_at, updated_at` +
    `) VALUES (` +
      `'${esc(id)}', ` +
      `'${esc(args.name)}', ` +
      `'${esc(args.project)}', ` +
      `'${esc(args.projectKey)}', ` +
      `'${esc(args.localPath)}', ` +
      `'${esc(args.install)}', ` +
      `'${esc(sourceSessionsJson)}', ` +
      `'${esc(args.sourceAgent)}', ` +
      `'${esc(args.scope)}', ` +
      `'${esc(args.author)}', ` +
      `'${esc(contributorsJson)}', ` +
      `'${esc(args.description)}', ` +
      `'${esc(args.trigger ?? "")}', ` +
      `'${esc(args.body)}', ` +
      `${args.version}, ` +
      `'${esc(args.createdAt)}', ` +
      `'${esc(args.updatedAt)}'` +
    `)`;
  try {
    await args.query(sql);
  } catch (e: any) {
    if (isMissingTableError(e?.message)) {
      // Lazy-create the table on first use, then retry the insert once.
      await args.query(createSkillsTableSql(args.tableName));
      await args.query(sql);
      return;
    }
    if (isMissingContributorsColumnError(e?.message)) {
      // Lazy ALTER for deployments that predate the contributors column
      // (issue #118). One-shot retry — if the second INSERT still fails
      // for any reason, the original error propagates.
      await args.query(addContributorsColumnSql(args.tableName));
      await args.query(sql);
      return;
    }
    throw e;
  }
}
