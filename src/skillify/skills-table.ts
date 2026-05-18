import { randomUUID } from "node:crypto";
import { sqlIdent } from "../utils/sql.js";
import {
  SKILLS_COLUMNS,
  buildCreateTableSql,
  healMissingColumns,
  isMissingTableError,
  isMissingColumnError,
} from "../deeplake-schema.js";

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
  /** Deeplake workspace id — needed for the heal-pass introspection so the
   *  SELECT against `information_schema.columns` targets *this* workspace's
   *  copy of the table (multi-tenant catalog disambiguation). */
  workspaceId: string;
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
    return;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingTableError(msg)) {
      // Lazy-create on first use. Then run a heal pass before retrying:
      // if another worker raced us and pre-created an older `skills`
      // table between our INSERT and this CREATE, `CREATE TABLE IF NOT
      // EXISTS` silently no-op'd against the legacy schema, and the
      // retry would otherwise fail with the same missing-column error.
      // healMissingColumns is cheap on a freshly-created table (1
      // SELECT info_schema, 0 ALTERs).
      await args.query(buildCreateTableSql(args.tableName, SKILLS_COLUMNS));
      await healMissingColumns({
        query: args.query,
        tableName: args.tableName,
        workspaceId: args.workspaceId,
        columns: SKILLS_COLUMNS,
      });
      await args.query(sql);
      return;
    }
    if (isMissingColumnError(msg)) {
      // Any missing column — not just `contributors`. Run a heal pass over
      // the full schema (one SELECT info_schema, ALTER only the missing
      // ones — see deeplake-schema.ts) and retry the INSERT once. If the
      // diff said nothing was missing, the original error came from a
      // column outside our schema knowledge; rethrow rather than loop on
      // a retry that can't help. (`altered` being empty isn't enough on
      // its own — a race with another writer can heal every missing
      // column for us, and we still want to retry the INSERT.)
      const result = await healMissingColumns({
        query: args.query,
        tableName: args.tableName,
        workspaceId: args.workspaceId,
        columns: SKILLS_COLUMNS,
      });
      if (result.missing.length === 0) throw e;
      await args.query(sql);
      return;
    }
    throw e;
  }
}
