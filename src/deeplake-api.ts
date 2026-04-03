import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
            results.push({
              path: entry.path,
              op: entry.op,
              snippet: String(entry.content).slice(0, 500),
              timestamp: entry.timestamp,
            });
            if (results.length >= limit) return results;
          }
        } catch { /* skip malformed lines */ }
      }
    }
    return results;
  }
}
