import { randomUUID } from "node:crypto";
import { log as _log } from "./utils/debug.js";
import { sqlStr, sqlIdent } from "./utils/sql.js";
import { SUMMARY_EMBEDDING_COL } from "./embeddings/columns.js";
import { deeplakeClientHeader } from "./utils/client-header.js";
import {
  MEMORY_COLUMNS,
  SESSIONS_COLUMNS,
  SKILLS_COLUMNS,
  buildCreateTableSql,
  healMissingColumns,
} from "./deeplake-schema.js";

// index-marker-store touches node:fs. Load it lazily so bundlers that split
// chunks (e.g. the openclaw plugin build) can put fs operations in a separate
// chunk from this file's network operations.
type IndexMarkerStore = typeof import("./index-marker-store.js");
let indexMarkerStorePromise: Promise<IndexMarkerStore> | null = null;
function getIndexMarkerStore(): Promise<IndexMarkerStore> {
  if (!indexMarkerStorePromise) indexMarkerStorePromise = import("./index-marker-store.js");
  return indexMarkerStorePromise;
}

const log = (msg: string) => _log("sdk", msg);

function summarizeSql(sql: string, maxLen = 220): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

/**
 * SQL tracing is opt-in and evaluated on every call so callers can flip the
 * env vars after module load (e.g. the one-shot shell bundle silences
 * `[deeplake-sql]` stderr writes so they don't land in Claude Code's
 * Bash-tool result — Claude Code merges child stderr into tool_result).
 */
function traceSql(msg: string): void {
  const traceEnabled = process.env.HIVEMIND_TRACE_SQL === "1"
    || process.env.HIVEMIND_DEBUG === "1";
  if (!traceEnabled) return;
  process.stderr.write(`[deeplake-sql] ${msg}\n`);
  if (process.env.HIVEMIND_DEBUG === "1") log(msg);
}

// ── Retry & concurrency primitives ──────────────────────────────────────────

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_CONCURRENCY = 5;

// Lazy read: the openclaw bundle replaces `process.env.HIVEMIND_QUERY_TIMEOUT_MS`
// with a `globalThis.__hivemind_tuning__?.HIVEMIND_QUERY_TIMEOUT_MS` lookup via
// esbuild `define`. The lookup must happen at call-time (not module-init) so
// it picks up the value openclaw populates AFTER this module is imported.
// Was previously `const QUERY_TIMEOUT_MS = …` at module top — that would have
// frozen the value to 10000 for the openclaw bundle regardless of pluginConfig.
function getQueryTimeoutMs(): number {
  return Number(process.env.HIVEMIND_QUERY_TIMEOUT_MS ?? 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name.includes("timeout") ||
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("timed out");
}

function isDuplicateIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("duplicate key value violates unique constraint") ||
    message.includes("pg_class_relname_nsp_index") ||
    message.includes("already exists");
}

function isSessionInsertQuery(sql: string): boolean {
  return /^\s*insert\s+into\s+"[^"]+"\s*\(\s*id\s*,\s*path\s*,\s*filename\s*,\s*message\s*,/i.test(sql);
}

function isTransientHtml403(text: string): boolean {
  const body = text.toLowerCase();
  return body.includes("<html") ||
    body.includes("403 forbidden") ||
    body.includes("cloudflare") ||
    body.includes("nginx");
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) { this.active++; next(); }
  }
}

// ── SDK-backed client (ManagedClient for all reads/writes) ───────────────────

export interface WriteRow {
  path: string;
  filename: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  project?: string;
  description?: string;
  creationDate?: string;
  lastUpdateDate?: string;
}

export class DeeplakeApi {
  private _pendingRows: WriteRow[] = [];
  private _sem = new Semaphore(MAX_CONCURRENCY);
  private _tablesCache: string[] | null = null;

  constructor(
    private token: string,
    private apiUrl: string,
    private orgId: string,
    private workspaceId: string,
    readonly tableName: string,
  ) {}

  /** Execute SQL with retry on transient errors and bounded concurrency. */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const startedAt = Date.now();
    const summary = summarizeSql(sql);
    traceSql(`query start: ${summary}`);
    await this._sem.acquire();
    try {
      const rows = await this._queryWithRetry(sql);
      traceSql(`query ok (${Date.now() - startedAt}ms, rows=${rows.length}): ${summary}`);
      return rows;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      traceSql(`query fail (${Date.now() - startedAt}ms): ${summary} :: ${message}`);
      throw e;
    } finally {
      this._sem.release();
    }
  }

  private async _queryWithRetry(sql: string): Promise<Record<string, unknown>[]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let resp: Response;
      const timeoutMs = getQueryTimeoutMs();
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader(),
          },
          signal,
          body: JSON.stringify({ query: sql }),
        });
      } catch (e: unknown) {
        // Network-level failure (DNS, TCP reset, timeout, etc.)
        if (isTimeoutError(e)) {
          lastError = new Error(`Query timeout after ${timeoutMs}ms`);
          throw lastError;
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
          log(`query retry ${attempt + 1}/${MAX_RETRIES} (fetch error: ${lastError.message}) in ${delay.toFixed(0)}ms`);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
      if (resp.ok) {
        const raw = await resp.json() as { columns?: string[]; rows?: unknown[][]; row_count?: number } | null;
        if (!raw?.rows || !raw?.columns) return [];
        return raw.rows.map(row =>
          Object.fromEntries(raw.columns!.map((col, i) => [col, row[i]]))
        );
      }
      const text = await resp.text().catch(() => "");
      const retryable403 =
        isSessionInsertQuery(sql) &&
        (resp.status === 401 || (resp.status === 403 && (text.length === 0 || isTransientHtml403(text))));
      // Deeplake returns HTTP 500 (not 409) when ADD COLUMN IF NOT EXISTS / CREATE
      // INDEX IF NOT EXISTS hit an already-present object. The error is
      // deterministic — retrying just burns ~4s of exponential backoff per call,
      // and SessionStart issues several of these on every run. Fail fast.
      const alreadyExists = resp.status === 500 && isDuplicateIndexError(text);
      if (!alreadyExists && attempt < MAX_RETRIES && (RETRYABLE_CODES.has(resp.status) || retryable403)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
        log(`query retry ${attempt + 1}/${MAX_RETRIES} (${resp.status}) in ${delay.toFixed(0)}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw lastError ?? new Error("Query failed: max retries exceeded");
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Queue rows for writing. Call commit() to flush. */
  appendRows(rows: WriteRow[]): void {
    this._pendingRows.push(...rows);
  }

  /** Flush pending rows via SQL. */
  async commit(): Promise<void> {
    if (this._pendingRows.length === 0) return;
    const rows = this._pendingRows;
    this._pendingRows = [];

    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map(r => this.upsertRowSql(r)));
    }
    log(`commit: ${rows.length} rows`);
  }

  private async upsertRowSql(row: WriteRow): Promise<void> {
    const ts = new Date().toISOString();
    const cd = row.creationDate ?? ts;
    const lud = row.lastUpdateDate ?? ts;
    const exists = await this.query(
      `SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`
    );
    if (exists.length > 0) {
      let setClauses = `summary = E'${sqlStr(row.contentText)}', ` +
        `${SUMMARY_EMBEDDING_COL} = NULL, ` +
        `mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== undefined) setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== undefined) setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(
        `UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`
      );
    } else {
      const id = randomUUID();
      let cols = `id, path, filename, summary, ${SUMMARY_EMBEDDING_COL}, mime_type, size_bytes, creation_date, last_update_date`;
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', NULL, '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
      if (row.project !== undefined) { cols += ", project"; vals += `, '${sqlStr(row.project)}'`; }
      if (row.description !== undefined) { cols += ", description"; vals += `, '${sqlStr(row.description)}'`; }
      await this.query(
        `INSERT INTO "${this.tableName}" (${cols}) VALUES (${vals})`
      );
    }
  }

  /** Update specific columns on a row by path. */
  async updateColumns(path: string, columns: Record<string, string | number>): Promise<void> {
    const setClauses = Object.entries(columns)
      .map(([col, val]) => typeof val === "number" ? `${col} = ${val}` : `${col} = '${sqlStr(String(val))}'`)
      .join(", ");
    await this.query(
      `UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(path)}'`
    );
  }

  // ── Convenience ─────────────────────────────────────────────────────────────

  /** Create a BM25 search index on a column. */
  async createIndex(column: string): Promise<void> {
    await this.query(`CREATE INDEX IF NOT EXISTS idx_${sqlStr(column)}_bm25 ON "${this.tableName}" USING deeplake_index ("${column}")`);
  }

  private buildLookupIndexName(table: string, suffix: string): string {
    return `idx_${table}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  private async ensureLookupIndex(table: string, suffix: string, columnsSql: string): Promise<void> {
    const markers = await getIndexMarkerStore();
    const markerPath = markers.buildIndexMarkerPath(this.workspaceId, this.orgId, table, suffix);
    if (markers.hasFreshIndexMarker(markerPath)) return;
    const indexName = this.buildLookupIndexName(table, suffix);
    try {
      await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ${columnsSql}`);
      markers.writeIndexMarker(markerPath);
    } catch (e: any) {
      if (isDuplicateIndexError(e)) {
        markers.writeIndexMarker(markerPath);
        return;
      }
      log(`index "${indexName}" skipped: ${e.message}`);
    }
  }

  /**
   * Heal any missing columns on a table so it matches one of the schema
   * definitions in `deeplake-schema.ts`. One SELECT against
   * `information_schema.columns` per call, then `ALTER TABLE ADD COLUMN`
   * only the genuinely missing ones — never blanket, never `IF NOT
   * EXISTS`.
   *
   * History: an earlier path used a local marker file (`col_<name>` under
   * the index-marker dir) to skip even the SELECT after the first
   * confirmation, plus per-column ALTERs for `summary_embedding`,
   * `message_embedding`, `agent`, `plugin_version`. The marker existed
   * because Deeplake used to expose a ~30s post-ALTER bug where
   * subsequent INSERTs failed, so we wanted to keep ALTER traffic to a
   * minimum. The bug was re-verified on 2026-05-18 against
   * `api.deeplake.ai` (`test_plugin` org) and no longer reproduces
   * (71/71 INSERTs OK, first success 2ms after ALTER). The single SELECT
   * + targeted ALTER pattern survives the marker removal because: each
   * ALTER still costs ~800ms (so blanket sweeps are wasteful) and the
   * diff produces clearer logs than "ALTER all with IF NOT EXISTS".
   */
  private async healSchema(table: string, columns: typeof MEMORY_COLUMNS): Promise<void> {
    await healMissingColumns({
      query: sql => this.query(sql) as Promise<unknown>,
      tableName: table,
      workspaceId: this.workspaceId,
      columns,
      log,
    });
  }

  /** List all tables in the workspace (with retry). */
  async listTables(forceRefresh = false): Promise<string[]> {
    if (!forceRefresh && this._tablesCache) return [...this._tablesCache];

    const { tables, cacheable } = await this._fetchTables();
    if (cacheable) this._tablesCache = [...tables];
    return tables;
  }

  private async _fetchTables(): Promise<{ tables: string[]; cacheable: boolean }> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader(),
          },
        });
        if (resp.ok) {
          const data = await resp.json() as { tables?: { table_name: string }[] };
          return {
            tables: (data.tables ?? []).map(t => t.table_name),
            cacheable: true,
          };
        }
        if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        return { tables: [], cacheable: false };
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return { tables: [], cacheable: false };
      }
    }
    return { tables: [], cacheable: false };
  }

  /**
   * Run a `CREATE TABLE` with an extra outer retry budget. The base
   * `query()` already retries 3 times on fetch errors (~3.5s total), but a
   * failed CREATE is permanent corruption — every subsequent SELECT against
   * the missing table fails. Wrapping in an outer loop with longer backoff
   * (2s, 5s, then 10s) gives us ~17s of reach across transient network
   * blips before giving up. Failures still propagate; getApi() resets its
   * cache on init failure (openclaw plugin) so the next call retries the
   * whole init flow.
   */
  private async createTableWithRetry(sql: string, label: string): Promise<void> {
    const OUTER_BACKOFFS_MS = [2000, 5000, 10000];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= OUTER_BACKOFFS_MS.length; attempt++) {
      try {
        await this.query(sql);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        log(`CREATE TABLE "${label}" attempt ${attempt + 1}/${OUTER_BACKOFFS_MS.length + 1} failed: ${msg}`);
        if (attempt < OUTER_BACKOFFS_MS.length) {
          await sleep(OUTER_BACKOFFS_MS[attempt]);
        }
      }
    }
    throw lastErr;
  }

  /** Create the memory table if it doesn't already exist. Heal missing columns on existing tables. */
  async ensureTable(name?: string): Promise<void> {
    // Drift guard runs *before* any SQL: ensures fresh tables can't be
    // created with a MEMORY_COLUMNS that has drifted from
    // SUMMARY_EMBEDDING_COL (used by the SDK on the write path).
    if (!MEMORY_COLUMNS.some(c => c.name === SUMMARY_EMBEDDING_COL)) {
      throw new Error(`MEMORY_COLUMNS missing "${SUMMARY_EMBEDDING_COL}" (embeddings/columns.ts drift)`);
    }
    // sqlIdent throws on anything outside [A-Za-z_][A-Za-z0-9_]* — protects
    // against HIVEMIND_TABLE config injection (a stray quote would otherwise
    // break CREATE TABLE / ALTER COLUMN / CREATE INDEX startup, and widen the
    // SQL-injection surface for config-driven values).
    const tbl = sqlIdent(name ?? this.tableName);
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log(`table "${tbl}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(tbl, MEMORY_COLUMNS), tbl);
      log(`table "${tbl}" created`);
      if (!tables.includes(tbl)) this._tablesCache = [...tables, tbl];
    }
    // Always heal after the create/exists decision. Reason: `listTables()`
    // is cached, so a stale cache plus a concurrent CREATE from another
    // writer means `CREATE TABLE IF NOT EXISTS` here can silently no-op
    // against a legacy table. Running healSchema unconditionally covers
    // that race; on a genuinely fresh CREATE the SELECT sees the canonical
    // column set and triggers zero ALTERs (one extra SELECT, ~250ms).
    await this.healSchema(tbl, MEMORY_COLUMNS);
    // BM25 index disabled — CREATE INDEX causes intermittent oid errors on fresh tables.
    // See bm25-oid-bug.sh for reproduction. Re-enable once Deeplake fixes the oid invalidation.
  }

  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name: string): Promise<void> {
    // sqlIdent throws on anything outside [A-Za-z_][A-Za-z0-9_]* — same
    // injection guard rationale as ensureTable / ensureSkillsTable. The name
    // here ultimately comes from HIVEMIND_SESSIONS_TABLE.
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, SESSIONS_COLUMNS), safe);
      log(`table "${safe}" created`);
      if (!tables.includes(safe)) this._tablesCache = [...tables, safe];
    }
    // Always heal — covers the stale-listTables race the same way as
    // ensureTable. Cheap when the table was genuinely fresh.
    await this.healSchema(safe, SESSIONS_COLUMNS);
    await this.ensureLookupIndex(safe, "path_creation_date", `("path", "creation_date")`);
  }

  /**
   * Create the skills table.
   *
   * One row per skill version. Workers INSERT a fresh row on every KEEP /
   * MERGE rather than UPDATE-ing in place, so the full version history is
   * recoverable. Uniqueness in the *current* state is by (project_key, name)
   * — newer rows shadow older ones at read time (ORDER BY version DESC).
   * This sidesteps the Deeplake UPDATE-coalescing quirk that bit the wiki
   * worker.
   */
  async ensureSkillsTable(name: string): Promise<void> {
    // Validate the table identifier before any SQL interpolation.
    // `name` ultimately comes from HIVEMIND_SKILLS_TABLE — a stray quote
    // or other invalid character would otherwise break startup AND widen
    // the SQL-injection surface for config-driven values.
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, SKILLS_COLUMNS), safe);
      log(`table "${safe}" created`);
      if (!tables.includes(safe)) this._tablesCache = [...tables, safe];
    }
    // Always heal — same rationale as ensureTable / ensureSessionsTable.
    await this.healSchema(safe, SKILLS_COLUMNS);
    await this.ensureLookupIndex(safe, "project_key_name", `("project_key", "name")`);
  }
}
