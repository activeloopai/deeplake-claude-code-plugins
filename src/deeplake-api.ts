import {
  ManagedClient,
  initializeWasm,
  deeplakeSetEndpointAndOpen,
  deeplakeAppend,
  deeplakeCommit,
} from "deeplake";
import { randomUUID } from "node:crypto";
import { log as _log } from "./utils/debug.js";
import { sqlStr } from "./utils/sql.js";

const log = (msg: string) => _log("sdk", msg);

// ── SDK-backed client ────────────────────────────────────────────────────────

let wasmInitialized = false;

export interface WriteRow {
  path: string;
  filename: string;
  content: Buffer;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  project?: string;
  description?: string;
  creationDate?: string;
  lastUpdateDate?: string;
}

export class DeeplakeApi {
  private client: ManagedClient;
  private _credsApplied = false;
  private _wasmDs: any = null;
  private _wasmHealthy = true;
  private _pendingRows: WriteRow[] = [];

  constructor(
    private token: string,
    private apiUrl: string,
    private orgId: string,
    private workspaceId: string,
    readonly tableName: string,
  ) {
    this.client = new ManagedClient({
      token,
      workspaceId,
      apiUrl,
      orgId,
    });
  }

  /** Initialize WASM engine (once per process). */
  static async initWasm(): Promise<void> {
    if (wasmInitialized) return;
    await initializeWasm();
    wasmInitialized = true;
  }

  /** Apply storage credentials for read/write access. */
  async applyStorageCreds(mode = "readwrite"): Promise<void> {
    if (this._credsApplied) return;
    await this.client.applyStorageCreds(mode);
    this._credsApplied = true;
  }

  /** Open the WASM dataset for direct S3 writes. Uses al:// path like the CLI. */
  async openDataset(timeoutMs = 30000): Promise<void> {
    if (this._wasmDs) return;
    try {
      // Use al:// path — triggers credential resolution in WASM C++ backend
      const alPath = `al://${this.workspaceId}/${this.tableName}`;
      log(`opening dataset: ${alPath}`);
      const openPromise = deeplakeSetEndpointAndOpen(this.apiUrl, alPath, "", this.token);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dataset open timed out")), timeoutMs),
      );
      this._wasmDs = await Promise.race([openPromise, timeout]);
      log("dataset opened");
    } catch (e: any) {
      log(`dataset open failed (will use SQL fallback): ${e.message}`);
      this._wasmHealthy = false;
    }
  }

  /** Get the underlying ManagedClient. */
  getClient(): ManagedClient {
    return this.client;
  }

  /** Execute SQL and return results as row-objects. */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    return this.client.query(sql);
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Queue rows for writing. Call commit() to flush. */
  appendRows(rows: WriteRow[]): void {
    this._pendingRows.push(...rows);
  }

  /** Flush pending rows — WASM path first, SQL fallback on failure. */
  async commit(): Promise<void> {
    if (this._pendingRows.length === 0) return;
    const rows = this._pendingRows;
    this._pendingRows = [];

    // Pre-delete existing rows (WASM does INSERT, not UPSERT)
    const paths = rows.map(r => r.path);
    const escapedPaths = paths.map(p => `'${sqlStr(p)}'`).join(", ");
    try {
      await this.query(`DELETE FROM "${this.tableName}" WHERE path IN (${escapedPaths})`);
    } catch {
      // May fail for new files — that's fine
    }

    // WASM write path (primary)
    if (this._wasmDs && this._wasmHealthy) {
      try {
        const batch: Record<string, unknown[]> = {
          _id: rows.map(() => randomUUID()),
          content: rows.map(r => r.content),
          content_text: rows.map(r => r.contentText),
          filename: rows.map(r => r.filename),
          mime_type: rows.map(r => r.mimeType),
          path: rows.map(r => r.path),
          size_bytes: rows.map(r => r.sizeBytes),
        };
        await deeplakeAppend(this._wasmDs, batch);
        await deeplakeCommit(this._wasmDs);
        log(`WASM commit: ${rows.length} rows`);
        return;
      } catch (e: any) {
        log(`WASM commit failed, falling back to SQL: ${e.message}`);
        this._wasmHealthy = false;
      }
    }

    // SQL fallback
    await this.commitViaSql(rows);
  }

  /** SQL fallback — hex-encoded INSERT with concurrency limit. */
  private async commitViaSql(rows: WriteRow[]): Promise<void> {
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map(r => this.upsertRowSql(r)));
    }
    log(`SQL commit: ${rows.length} rows`);
  }

  private async upsertRowSql(row: WriteRow): Promise<void> {
    const hex = row.content.toString("hex");
    const ts = new Date().toISOString();
    const cd = row.creationDate ?? ts;
    const lud = row.lastUpdateDate ?? ts;
    const exists = await this.query(
      `SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`
    );
    if (exists.length > 0) {
      let setClauses = `content = E'\\\\x${hex}', content_text = E'${sqlStr(row.contentText)}', ` +
        `mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== undefined) setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== undefined) setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(
        `UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`
      );
    } else {
      const id = randomUUID();
      let cols = "id, path, filename, content, content_text, mime_type, size_bytes, creation_date, last_update_date";
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'\\\\x${hex}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
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
    await this.client.createIndex(this.tableName, column);
  }

  /** List all tables in the workspace. */
  async listTables(): Promise<string[]> {
    return this.client.listTables();
  }

  /** Create the table if it doesn't already exist. */
  async ensureTable(): Promise<void> {
    const tables = await this.listTables();
    if (!tables.includes(this.tableName)) {
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
          `project TEXT NOT NULL DEFAULT '', ` +
          `description TEXT NOT NULL DEFAULT '', ` +
          `creation_date TEXT NOT NULL DEFAULT '', ` +
          `last_update_date TEXT NOT NULL DEFAULT ''` +
        `) USING deeplake`,
      );
      log(`table "${this.tableName}" created`);
    } else {
      // Migrate: add new columns if missing on existing tables
      for (const col of ["project", "description", "creation_date", "last_update_date"]) {
        try {
          await this.query(`ALTER TABLE "${this.tableName}" ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
          log(`added column "${col}" to "${this.tableName}"`);
        } catch {
          // Column already exists — ignore
        }
      }
    }
  }
}
