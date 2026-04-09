export interface SearchResult {
  path: string;
  snippet: string;
  lineStart: number;
  score: number;
}

const TABLE_NAME = "deeplake_plugin_memory";

/**
 * DeepLake REST API client for memory operations.
 * All operations use fetch() — pure HTTP, no shell commands.
 */
export class DeepLakeAPI {
  private tableReady = false;

  constructor(
    private token: string,
    private orgId: string,
    private apiUrl: string,
    private workspace: string = "default",
  ) {}

  private async query(sql: string): Promise<{ columns: string[]; rows: unknown[][]; row_count: number }> {
    const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspace}/tables/query`, {
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

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await fetch(`${this.apiUrl}/workspaces/${this.workspace}/tables`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-Activeloop-Org-Id": this.orgId,
        },
        body: JSON.stringify({
          table_name: TABLE_NAME,
          table_schema: {
            id: "TEXT",
            session_id: "TEXT",
            role: "TEXT",
            content: "TEXT",
            timestamp: "TEXT",
            channel: "TEXT",
            sender: "TEXT",
          },
        }),
      });
    } catch {
      // Table might already exist — that's fine
    }
    this.tableReady = true;
  }

  async write(
    sessionId: string,
    role: string,
    content: string,
    channel?: string,
    sender?: string,
  ): Promise<void> {
    await this.ensureTable();
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const esc = (s: string) => s.replace(/'/g, "''");
    const sql = `INSERT INTO "${TABLE_NAME}" (id, session_id, role, content, timestamp, channel, sender) VALUES ('${esc(id)}', '${esc(sessionId)}', '${esc(role)}', '${esc(content)}', '${esc(ts)}', '${esc(channel ?? "")}', '${esc(sender ?? "")}')`;
    await this.query(sql);
  }

  async search(queryText: string, limit = 10): Promise<SearchResult[]> {
    if (!queryText.trim()) return [];
    await this.ensureTable();
    const esc = queryText.replace(/'/g, "''");
    const sql = `SELECT session_id, role, content, timestamp FROM "${TABLE_NAME}" WHERE content ILIKE '%${esc}%' ORDER BY timestamp DESC LIMIT ${limit}`;
    try {
      const result = await this.query(sql);
      return result.rows.map((row, i) => ({
        path: `session:${row[0]}`,
        snippet: `[${row[1]}] ${String(row[2]).slice(0, 500)}`,
        lineStart: i + 1,
        score: 1.0,
      }));
    } catch {
      return [];
    }
  }

  async read(sessionId?: string, limit = 50): Promise<string[]> {
    await this.ensureTable();
    const where = sessionId ? `WHERE session_id = '${sessionId.replace(/'/g, "''")}'` : "";
    const sql = `SELECT role, content, timestamp FROM "${TABLE_NAME}" ${where} ORDER BY timestamp DESC LIMIT ${limit}`;
    try {
      const result = await this.query(sql);
      return result.rows.map(row => `[${row[0]}] ${row[1]}`);
    } catch {
      return [];
    }
  }
}
