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
    const sql = `INSERT INTO "${this.tableName}" (path, filename, content, content_text, mime_type, size_bytes) ` +
      `VALUES ('${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'\\\\x${hex}', E'${sqlStr(row.contentText)}', '${sqlStr(row.mimeType)}', ${row.sizeBytes})`;
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
    await this.client.createIndex(this.tableName, column);
  }

  /** List all tables in the workspace. */
  async listTables(): Promise<string[]> {
    return this.client.listTables();
  }
}
