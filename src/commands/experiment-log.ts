/**
 * Generic experiment log logic. Used by the log-experiment CLI; also importable.
 *
 * Schema (auto-created by ensureExperimentTable):
 *   id                TEXT     UUID, internal row id
 *   change_identifier TEXT     opaque change ref (commit, patch hash, worktree, A/B id, ...)
 *   metric            FLOAT64  numeric score (direction interpreted by callers)
 *   metadata          JSONB    open-ended bag (run_tag, direction, branch, memory_gb, ...)
 *   status            TEXT     keep | discard | crash | (free-form)
 *   description       TEXT     free-text rationale
 *   global_promoted   TEXT     'yes' | 'no' | ''  ("adopted as new global baseline")
 *   timestamp         TEXT     ISO 8601 string
 */

import { randomUUID } from "node:crypto";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";

export interface ExperimentRow {
  changeIdentifier: string;
  metric: number;
  status: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteOptions {
  changeIdentifier: string;
  id?: string;
  unset?: boolean;
}

/** Create the experiment table if it doesn't exist. Idempotent. */
export async function ensureExperimentTable(
  api: DeeplakeApi,
  tableName: string,
): Promise<void> {
  const tbl = sqlIdent(tableName);
  const existing = await api.listTables();
  if (existing.includes(tbl)) return;

  await api.query(
    `CREATE TABLE IF NOT EXISTS "${tbl}" (` +
      `id TEXT NOT NULL DEFAULT '', ` +
      `change_identifier TEXT NOT NULL DEFAULT '', ` +
      `metric FLOAT64 NOT NULL DEFAULT 0, ` +
      `metadata JSONB, ` +
      `status TEXT NOT NULL DEFAULT '', ` +
      `description TEXT NOT NULL DEFAULT '', ` +
      `global_promoted TEXT NOT NULL DEFAULT '', ` +
      `timestamp TEXT NOT NULL DEFAULT ''` +
    `) USING deeplake`,
  );
}

/** Append a single experiment row. Returns the row id (UUID). */
export async function logExperiment(
  api: DeeplakeApi,
  tableName: string,
  row: ExperimentRow,
): Promise<string> {
  const tbl = sqlIdent(tableName);
  const id = randomUUID();
  const ts = new Date().toISOString();
  const metaJson = row.metadata !== undefined ? JSON.stringify(row.metadata) : "{}";
  // For JSONB literals: only escape single quotes. sqlStr() also doubles backslashes
  // and strips control chars, which would corrupt JSON (e.g. "\n" → "\\n"). Same idiom
  // as src/hooks/capture.ts:114-121 uses for the sessions.message column.
  const metaForSql = metaJson.replace(/'/g, "''");

  const sql =
    `INSERT INTO "${tbl}" ` +
    `(id, change_identifier, metric, metadata, status, description, global_promoted, timestamp) ` +
    `VALUES (` +
      `'${id}', ` +
      `'${sqlStr(row.changeIdentifier)}', ` +
      `${row.metric}, ` +
      `'${metaForSql}'::jsonb, ` +
      `'${sqlStr(row.status)}', ` +
      `'${sqlStr(row.description)}', ` +
      `'no', ` +
      `'${ts}'` +
    `)`;

  await api.query(sql);
  return id;
}

/** Set global_promoted on a row, matched by id when given, else by change_identifier. */
export async function promoteExperiment(
  api: DeeplakeApi,
  tableName: string,
  opts: PromoteOptions,
): Promise<void> {
  const tbl = sqlIdent(tableName);
  const value = opts.unset ? "no" : "yes";
  const where = opts.id
    ? `id = '${sqlStr(opts.id)}'`
    : `change_identifier = '${sqlStr(opts.changeIdentifier)}'`;
  await api.query(
    `UPDATE "${tbl}" SET global_promoted = '${value}' WHERE ${where}`,
  );
}
