import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log as _log } from "./utils/debug.js";
import { sqlStr } from "./utils/sql.js";
import { deeplakeClientHeader } from "./utils/client-header.js";

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
const QUERY_TIMEOUT_MS = Number(process.env.HIVEMIND_QUERY_TIMEOUT_MS ?? 10_000);
const INDEX_MARKER_TTL_MS = Number(process.env.HIVEMIND_INDEX_MARKER_TTL_MS ?? 6 * 60 * 60_000);

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

function getIndexMarkerDir(): string {
  return process.env.HIVEMIND_INDEX_MARKER_DIR ?? join(tmpdir(), "hivemind-deeplake-indexes");
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
      try {
        const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
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
          lastError = new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms`);
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
      if (attempt < MAX_RETRIES && (RETRYABLE_CODES.has(resp.status) || retryable403)) {
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
        `mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== undefined) setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== undefined) setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(
        `UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`
      );
    } else {
      const id = randomUUID();
      let cols = "id, path, filename, summary, mime_type, size_bytes, creation_date, last_update_date";
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
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

  private getLookupIndexMarkerPath(table: string, suffix: string): string {
    const markerKey = [
      this.workspaceId,
      this.orgId,
      table,
      suffix,
    ].join("__").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(getIndexMarkerDir(), `${markerKey}.json`);
  }

  private hasFreshLookupIndexMarker(table: string, suffix: string): boolean {
    const markerPath = this.getLookupIndexMarkerPath(table, suffix);
    if (!existsSync(markerPath)) return false;
    try {
      const raw = JSON.parse(readFileSync(markerPath, "utf-8")) as { updatedAt?: string };
      const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).getTime() : NaN;
      if (!Number.isFinite(updatedAt) || (Date.now() - updatedAt) > INDEX_MARKER_TTL_MS) return false;
      return true;
    } catch {
      return false;
    }
  }

  private markLookupIndexReady(table: string, suffix: string): void {
    mkdirSync(getIndexMarkerDir(), { recursive: true });
    writeFileSync(
      this.getLookupIndexMarkerPath(table, suffix),
      JSON.stringify({ updatedAt: new Date().toISOString() }),
      "utf-8",
    );
  }

  private async ensureLookupIndex(table: string, suffix: string, columnsSql: string): Promise<void> {
    if (this.hasFreshLookupIndexMarker(table, suffix)) return;
    const indexName = this.buildLookupIndexName(table, suffix);
    try {
      await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ${columnsSql}`);
      this.markLookupIndexReady(table, suffix);
    } catch (e: any) {
      if (isDuplicateIndexError(e)) {
        this.markLookupIndexReady(table, suffix);
        return;
      }
      log(`index "${indexName}" skipped: ${e.message}`);
    }
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

  /** Create the memory table if it doesn't already exist. Migrate columns on existing tables. */
  async ensureTable(name?: string): Promise<void> {
    const tbl = name ?? this.tableName;
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log(`table "${tbl}" not found, creating`);
      await this.query(
        `CREATE TABLE IF NOT EXISTS "${tbl}" (` +
          `id TEXT NOT NULL DEFAULT '', ` +
          `path TEXT NOT NULL DEFAULT '', ` +
          `filename TEXT NOT NULL DEFAULT '', ` +
          `summary TEXT NOT NULL DEFAULT '', ` +
          `author TEXT NOT NULL DEFAULT '', ` +
          `mime_type TEXT NOT NULL DEFAULT 'text/plain', ` +
          `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
          `project TEXT NOT NULL DEFAULT '', ` +
          `description TEXT NOT NULL DEFAULT '', ` +
          `agent TEXT NOT NULL DEFAULT '', ` +
          `creation_date TEXT NOT NULL DEFAULT '', ` +
          `last_update_date TEXT NOT NULL DEFAULT ''` +
        `) USING deeplake`,
      );
      log(`table "${tbl}" created`);
      if (!tables.includes(tbl)) this._tablesCache = [...tables, tbl];
    }
    // BM25 index disabled — CREATE INDEX causes intermittent oid errors on fresh tables.
    // See bm25-oid-bug.sh for reproduction. Re-enable once Deeplake fixes the oid invalidation.
    // try {
    //   await this.query(
    //     `CREATE INDEX IF NOT EXISTS idx_${tbl}_summary_bm25 ON "${this.workspaceId}"."${tbl}" USING deeplake_index (summary) WITH (index_type = 'bm25')`
    //   );
    // } catch { /* index may already exist or not be supported */ }
  }

  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name: string): Promise<void> {
    const tables = await this.listTables();
    if (!tables.includes(name)) {
      log(`table "${name}" not found, creating`);
      await this.query(
        `CREATE TABLE IF NOT EXISTS "${name}" (` +
          `id TEXT NOT NULL DEFAULT '', ` +
          `path TEXT NOT NULL DEFAULT '', ` +
          `filename TEXT NOT NULL DEFAULT '', ` +
          `message JSONB, ` +
          `author TEXT NOT NULL DEFAULT '', ` +
          `mime_type TEXT NOT NULL DEFAULT 'application/json', ` +
          `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
          `project TEXT NOT NULL DEFAULT '', ` +
          `description TEXT NOT NULL DEFAULT '', ` +
          `agent TEXT NOT NULL DEFAULT '', ` +
          `creation_date TEXT NOT NULL DEFAULT '', ` +
          `last_update_date TEXT NOT NULL DEFAULT ''` +
        `) USING deeplake`,
      );
      log(`table "${name}" created`);
      if (!tables.includes(name)) this._tablesCache = [...tables, name];
    }
    await this.ensureLookupIndex(name, "path_creation_date", `("path", "creation_date")`);
  }
}
