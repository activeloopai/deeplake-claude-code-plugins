import { randomUUID } from "node:crypto";
import { log as _log } from "./utils/debug.js";
import { sqlStr } from "./utils/sql.js";

const log = (msg: string) => _log("sdk", msg);

// ── SDK-backed client (ManagedClient for all reads/writes) ───────────────────

export interface WriteRow {
  path: string;
  filename: string;
  content: Buffer;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
}

export class DeeplakeApi {
  private _pendingRows: WriteRow[] = [];

  constructor(
    private token: string,
    private apiUrl: string,
    private orgId: string,
    private workspaceId: string,
    readonly tableName: string,
  ) {}

  /** Execute SQL and return results as row-objects. */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-Activeloop-Org-Id": this.orgId,
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
    }
    const raw = await resp.json() as { columns?: string[]; rows?: unknown[][]; row_count?: number } | null;
    if (!raw?.rows || !raw?.columns) return [];
    return raw.rows.map(row =>
      Object.fromEntries(raw.columns!.map((col, i) => [col, row[i]]))
    );
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

    // Pre-delete existing rows
    const paths = rows.map(r => r.path);
    const escapedPaths = paths.map(p => `'${sqlStr(p)}'`).join(", ");
    try {
      await this.query(`DELETE FROM "${this.tableName}" WHERE path IN (${escapedPaths})`);
    } catch {
      // May fail for new files — that's fine
    }

    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map(r => this.upsertRowSql(r)));
    }
    log(`commit: ${rows.length} rows`);
  }

  private async upsertRowSql(row: WriteRow): Promise<void> {
    const hex = row.content.toString("hex");
    const id = randomUUID();
    const ts = new Date().toISOString();
    const sql = `INSERT INTO "${this.tableName}" (id, path, filename, content, content_text, mime_type, size_bytes, timestamp) ` +
      `VALUES ('${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'\\\\x${hex}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${ts}')`;
    try {
      await this.query(sql);
    } catch (e: any) {
      if (e.message?.includes("duplicate") || e.message?.includes("unique")) {
        const updateSql = `UPDATE "${this.tableName}" SET content = E'\\\\x${hex}', content_text = E'${sqlStr(row.contentText)}', ` +
          `mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes} WHERE path = '${sqlStr(row.path)}'`;
        await this.query(updateSql);
      } else {
        throw e;
      }
    }
  }

  // ── Convenience ─────────────────────────────────────────────────────────────

  /** Create a BM25 search index on a column. */
  async createIndex(column: string): Promise<void> {
    await this.query(`CREATE INDEX IF NOT EXISTS idx_${sqlStr(column)}_bm25 ON "${this.tableName}" USING deeplake_index ("${column}")`);
  }

  /** List all tables in the workspace. */
  async listTables(): Promise<string[]> {
    const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Activeloop-Org-Id": this.orgId,
      },
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { tables?: { table_name: string }[] };
    return (data.tables ?? []).map(t => t.table_name);
  }

  /** Create the table if it doesn't already exist. */
  async ensureTable(): Promise<void> {
    const tables = await this.listTables();
    if (tables.includes(this.tableName)) return;
    log(`table "${this.tableName}" not found, creating`);
    await this.query(
      `CREATE TABLE IF NOT EXISTS "${this.tableName}" (` +
        `id TEXT NOT NULL DEFAULT '', ` +
        `path TEXT NOT NULL DEFAULT '', ` +
        `filename TEXT NOT NULL DEFAULT '', ` +
        `content BYTEA NOT NULL DEFAULT ''::bytea, ` +
        `content_text TEXT NOT NULL DEFAULT '', ` +
        `mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', ` +
        `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
        `timestamp TEXT NOT NULL DEFAULT ''` +
      `) USING deeplake`,
    );
    log(`table "${this.tableName}" created`);
  }
}
