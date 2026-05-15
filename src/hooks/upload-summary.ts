/**
 * Shared summary-upload logic for claude-code + codex wiki workers.
 *
 * Combines the summary, size_bytes and description column writes into a
 * SINGLE UPDATE (or INSERT) statement — the Deeplake backend silently
 * drops one of two rapid UPDATEs on the same row, so splitting these
 * across two statements ends up losing the summary column while only
 * description lands.
 */

import { randomUUID } from "node:crypto";
import { embeddingSqlLiteral } from "../embeddings/sql.js";

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface UploadParams {
  tableName: string;
  vpath: string;
  fname: string;
  userName: string;
  project: string;
  agent: string;
  sessionId: string;
  text: string;
  ts?: string;
  /**
   * Pre-computed nomic embedding of `text` to store alongside the summary.
   * Passing `null` or `undefined` writes SQL NULL — the column stays
   * schema-compatible and the row is still reachable via the lexical
   * retrieval branch, it just won't show up in the semantic branch.
   */
  embedding?: number[] | null;
  /**
   * Hivemind plugin version that produced this summary.
   * - INSERT: omitted lands the column default (''), schema-compatible.
   * - UPDATE: omitted means "don't touch the column" — a refresh from a
   *   legacy spawner that doesn't pass pluginVersion must NOT overwrite
   *   a previously-stored real version with ''. Pass an explicit empty
   *   string when you genuinely want to clear it.
   */
  pluginVersion?: string;
}

export interface UploadResult {
  path: "update" | "insert";
  sql: string;
  descLength: number;
  summaryLength: number;
}

/** PostgreSQL E-string escaper: doubles backslashes and single quotes, strips control chars. */
export function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Derive the short description from the "## What Happened" section of a wiki summary. */
export function extractDescription(text: string): string {
  const match = text.match(/## What Happened\n([\s\S]*?)(?=\n##|$)/);
  return match ? match[1].trim().slice(0, 300) : "completed";
}

/**
 * Upload or refresh a wiki summary row.
 *
 * IMPORTANT: summary and description must stay in the SAME SQL statement.
 * See module docstring for the rationale.
 */
export async function uploadSummary(query: QueryFn, params: UploadParams): Promise<UploadResult> {
  const { tableName, vpath, fname, userName, project, agent, text } = params;
  const ts = params.ts ?? new Date().toISOString();
  const desc = extractDescription(text);
  const sizeBytes = Buffer.byteLength(text);
  const embSql = embeddingSqlLiteral(params.embedding ?? null);
  // Keep undefined sentinel for UPDATE conditional. INSERT still defaults to ''.
  const pluginVersion = params.pluginVersion;

  const existing = await query(
    `SELECT path FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`
  );

  if (existing.length > 0) {
    // Only include plugin_version in the SET clause when the caller
    // explicitly provided a value (including ''). A legacy spawner that
    // omits pluginVersion would otherwise erase a previously-stored
    // real version on every refresh. Keeping the column out of SET
    // leaves the existing row value untouched.
    const pluginVersionSet = pluginVersion === undefined
      ? ""
      : `plugin_version = '${esc(pluginVersion)}', `;
    const sql =
      `UPDATE "${tableName}" SET ` +
      `summary = E'${esc(text)}', ` +
      `summary_embedding = ${embSql}, ` +
      `size_bytes = ${sizeBytes}, ` +
      `description = E'${esc(desc)}', ` +
      pluginVersionSet +
      `last_update_date = '${ts}' ` +
      `WHERE path = '${esc(vpath)}'`;
    await query(sql);
    return { path: "update", sql, descLength: desc.length, summaryLength: text.length };
  }

  // INSERT path: new row, no previous value to preserve — default to ''.
  const pluginVersionForInsert = pluginVersion ?? "";
  const sql =
    `INSERT INTO "${tableName}" (id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${randomUUID()}', '${esc(vpath)}', '${esc(fname)}', E'${esc(text)}', ${embSql}, '${esc(userName)}', 'text/markdown', ` +
    `${sizeBytes}, '${esc(project)}', E'${esc(desc)}', '${esc(agent)}', '${esc(pluginVersionForInsert)}', '${ts}', '${ts}')`;
  await query(sql);
  return { path: "insert", sql, descLength: desc.length, summaryLength: text.length };
}
