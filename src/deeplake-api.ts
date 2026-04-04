import { basename } from "node:path";

const esc = (s: string) => s.replace(/'/g, "''");

export class DeeplakeApi {
  constructor(
    private token: string,
    private apiUrl: string,
    private orgId: string,
    private workspaceId: string,
    readonly tableName: string,
  ) {}

  /** Execute SQL and return results as row-objects (Record<col, value>[]). */
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
      throw new Error(`Deeplake API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const raw = await resp.json() as { columns?: string[]; rows?: unknown[][]; row_count?: number } | null;
    if (!raw?.rows || !raw?.columns) return [];
    return raw.rows.map(row =>
      Object.fromEntries(raw.columns!.map((col, i) => [col, row[i]]))
    );
  }

  /** Record a file operation (used by the PostToolUse hook). */
  async logOp(sessionId: string, path: string, op: string, content: string): Promise<void> {
    const filename = basename(path);
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    const mime = filename.endsWith(".json") ? "application/json" : "text/plain";
    const meta = JSON.stringify({ session_id: sessionId, op, timestamp: new Date().toISOString() });
    await this.query(
      `INSERT INTO "${this.tableName}" (path, filename, content, content_text, mime_type, size_bytes) ` +
      `VALUES ('${esc(path)}', '${esc(filename)}', '${esc(content)}', '${esc(meta)}', '${esc(mime)}', ${sizeBytes})`
    );
  }
}
