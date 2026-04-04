import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Local file-based API (used by PostToolUse hook) ───────────────────────────

export interface SearchResult {
  path: string;
  op: string;
  snippet: string;
  timestamp: string;
}

export class DeepLakeApi {
  constructor(private memoryDir: string) {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
  }

  async logOp(sessionId: string, toolName: string, op: string, content: string): Promise<void> {
    const entry = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      path: toolName,
      op,
      content,
      timestamp: new Date().toISOString(),
    };
    const file = join(this.memoryDir, `session_${sessionId}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + "\n");
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const q = query.toLowerCase();
    const files = readdirSync(this.memoryDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const lines = readFileSync(join(this.memoryDir, file), "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.content?.toLowerCase().includes(q) || entry.path?.toLowerCase().includes(q)) {
            results.push({ path: entry.path, op: entry.op, snippet: String(entry.content).slice(0, 500), timestamp: entry.timestamp });
            if (results.length >= limit) return results;
          }
        } catch { /* skip malformed lines */ }
      }
    }
    return results;
  }
}

// ── HTTP SQL client (used by DeeplakeFs / virtual shell) ──────────────────────

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
}
