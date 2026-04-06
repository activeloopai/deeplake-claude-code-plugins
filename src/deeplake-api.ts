import { ManagedClient, initializeWasm } from "deeplake";

// ── SDK-backed client (replaces raw HTTP fetch) ──────────────────────────────

let wasmInitialized = false;

export class DeeplakeApi {
  private client: ManagedClient;
  private _credsApplied = false;

  constructor(
    token: string,
    apiUrl: string,
    orgId: string,
    workspaceId: string,
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

  /** Get the underlying ManagedClient. */
  getClient(): ManagedClient {
    return this.client;
  }

  /** Execute SQL and return results as row-objects. */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    return this.client.query(sql);
  }

  /** Create a BM25 search index on a column. */
  async createIndex(column: string): Promise<void> {
    await this.client.createIndex(this.tableName, column);
  }

  /** List all tables in the workspace. */
  async listTables(): Promise<string[]> {
    return this.client.listTables();
  }
}
