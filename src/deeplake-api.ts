import { basename } from "node:path";

const esc = (s: string) => s.replace(/'/g, "''");

export class DeepLakeApi {
  constructor(
    private token: string,
    private apiUrl: string,
    private orgId: string,
    private workspaceId: string,
    private tableName: string,
  ) {}

  private async query(sql: string): Promise<{ columns: string[]; rows: unknown[][]; row_count: number }> {
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
      throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  async logOp(sessionId: string, path: string, op: string, content: string): Promise<void> {
    const filename = basename(path);
    const contentBytes = Buffer.byteLength(content, "utf-8");
    const mime = filename.endsWith(".json") ? "application/json" : "text/plain";
    // content_text stores metadata (session, op, timestamp)
    const meta = JSON.stringify({ session_id: sessionId, op, timestamp: new Date().toISOString() });
    const sql = `INSERT INTO "${this.tableName}" (path, filename, content, content_text, mime_type, size_bytes) VALUES ('${esc(path)}', '${esc(filename)}', '${esc(content)}', '${esc(meta)}', '${esc(mime)}', ${contentBytes})`;
    await this.query(sql);
  }

  // v0.2: these map to just-bash IFileSystem
  async readFile(path: string): Promise<string | null> {
    const sql = `SELECT content FROM "${this.tableName}" WHERE path = '${esc(path)}' ORDER BY _id DESC LIMIT 1`;
    const result = await this.query(sql);
    return result.rows.length > 0 ? (result.rows[0][0] as string) : null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.logOp("", path, "write", content);
  }

  async listDir(dir: string): Promise<string[]> {
    const sql = `SELECT DISTINCT path FROM "${this.tableName}" WHERE path LIKE '${esc(dir)}%' ORDER BY path`;
    const result = await this.query(sql);
    return result.rows.map((r) => r[0] as string);
  }

  async search(query: string, limit = 10): Promise<{ path: string; snippet: string }[]> {
    const sql = `SELECT path, content FROM "${this.tableName}" WHERE content ILIKE '%${esc(query)}%' LIMIT ${limit}`;
    const result = await this.query(sql);
    return result.rows.map((r) => ({
      path: r[0] as string,
      snippet: String(r[1]).slice(0, 500),
    }));
  }
}
