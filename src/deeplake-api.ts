import { randomUUID } from "node:crypto";
import { log as _log } from "./utils/debug.js";
import { sqlStr } from "./utils/sql.js";

const log = (msg: string) => _log("sdk", msg);
const TRACE_SQL = process.env.DEEPLAKE_TRACE_SQL === "1" || process.env.DEEPLAKE_DEBUG === "1";
const DEBUG_FILE_LOG = process.env.DEEPLAKE_DEBUG === "1";

function summarizeSql(sql: string, maxLen = 220): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function traceSql(msg: string): void {
  if (!TRACE_SQL) return;
  process.stderr.write(`[deeplake-sql] ${msg}\n`);
  if (DEBUG_FILE_LOG) log(msg);
}

// ── Retry & concurrency primitives ──────────────────────────────────────────

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_CONCURRENCY = 5;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": this.orgId,
          },
          body: JSON.stringify({ query: sql }),
        });
      } catch (e: unknown) {
        // Network-level failure (DNS, TCP reset, timeout, etc.)
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
      if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
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

  /** List all tables in the workspace (with retry). */
  async listTables(): Promise<string[]> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "X-Activeloop-Org-Id": this.orgId,
          },
        });
        if (resp.ok) {
          const data = await resp.json() as { tables?: { table_name: string }[] };
          return (data.tables ?? []).map(t => t.table_name);
        }
        if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        return [];
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return [];
      }
    }
    return [];
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
    }
    // Ensure BM25 index exists on summary column (idempotent)
    try {
      await this.query(
        `CREATE INDEX IF NOT EXISTS idx_${tbl}_summary_bm25 ON "${this.workspaceId}"."${tbl}" USING deeplake_index (summary) WITH (index_type = 'bm25')`
      );
    } catch { /* index may already exist or not be supported */ }
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
    }
  }
}
