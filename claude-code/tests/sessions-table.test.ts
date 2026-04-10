import { describe, it, expect, vi } from "vitest";
import { DeeplakeFs, guessMime } from "../../src/shell/deeplake-fs.js";

// ── Mock client that simulates both memory and sessions tables ──────────────

interface Row {
  path: string;
  text_content: string;
  size_bytes: number;
  mime_type: string;
  creation_date: string;
  [key: string]: unknown;
}

function makeClient(memoryRows: Row[] = [], sessionRows: Row[] = []) {
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => {
      // Table sync — no-op
      if (sql.includes("deeplake_sync_table")) return [];

      // Determine which table is being queried
      const isSessionsQuery = sql.includes('"sessions"');
      const rows = isSessionsQuery ? sessionRows : memoryRows;

      // Bootstrap: SELECT path, size_bytes, mime_type (memory table)
      if (sql.includes("SELECT path, size_bytes, mime_type") && !isSessionsQuery) {
        return rows.map(r => ({ path: r.path, size_bytes: r.size_bytes, mime_type: r.mime_type }));
      }

      // Bootstrap: SELECT path, SUM(size_bytes) ... GROUP BY path (sessions table)
      if (sql.includes("SUM(size_bytes)") && sql.includes("GROUP BY")) {
        const groups = new Map<string, number>();
        for (const r of sessionRows) {
          groups.set(r.path, (groups.get(r.path) ?? 0) + r.size_bytes);
        }
        return [...groups.entries()].map(([path, total]) => ({ path, total_size: total }));
      }

      // Read session rows ordered by creation_date
      if (sql.includes("SELECT message") && isSessionsQuery && sql.includes("ORDER BY creation_date")) {
        const pathMatch = sql.match(/path = '([^']+)'/);
        if (pathMatch) {
          return sessionRows
            .filter(r => r.path === pathMatch[1])
            .sort((a, b) => a.creation_date.localeCompare(b.creation_date))
            .map(r => ({ message: r.text_content, creation_date: r.creation_date }));
        }
      }

      // Read from memory table
      if (sql.includes("SELECT summary FROM") && !isSessionsQuery) {
        const pathMatch = sql.match(/path = '([^']+)'/);
        if (pathMatch) {
          const row = memoryRows.find(r => r.path === pathMatch[1]);
          return row ? [{ summary: row.text_content }] : [];
        }
      }

      // Summary query for virtual index
      if (sql.includes("SELECT path, project, description")) {
        return memoryRows
          .filter(r => r.path.startsWith("/summaries/"))
          .map(r => ({ path: r.path, project: r.project ?? "", description: r.description ?? "", creation_date: r.creation_date, last_update_date: r.last_update_date ?? "" }));
      }

      // INSERT/UPDATE/DELETE — no-op for tests
      if (sql.startsWith("INSERT") || sql.startsWith("UPDATE") || sql.startsWith("DELETE")) return [];

      return [];
    }),
    listTables: vi.fn().mockResolvedValue(["memory", "sessions"]),
    ensureTable: vi.fn().mockResolvedValue(undefined),
  };
  return client;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DeeplakeFs — sessions table multi-row read", () => {
  it("reads session file by concatenating rows ordered by creation_date", async () => {
    const sessionRows: Row[] = [
      { path: "/sessions/alice/alice_org_default_s1.jsonl", text_content: '{"type":"user_message","content":"hello"}', size_bytes: 40, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
      { path: "/sessions/alice/alice_org_default_s1.jsonl", text_content: '{"type":"tool_call","tool_name":"Read"}', size_bytes: 38, mime_type: "application/json", creation_date: "2026-01-01T00:00:02Z" },
      { path: "/sessions/alice/alice_org_default_s1.jsonl", text_content: '{"type":"assistant_message","content":"done"}', size_bytes: 44, mime_type: "application/json", creation_date: "2026-01-01T00:00:03Z" },
    ];

    const client = makeClient([], sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const content = await fs.readFile("/sessions/alice/alice_org_default_s1.jsonl");
    const lines = content.split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).type).toBe("user_message");
    expect(JSON.parse(lines[1]).type).toBe("tool_call");
    expect(JSON.parse(lines[2]).type).toBe("assistant_message");
  });

  it("preserves creation_date ordering even if inserted out of order", async () => {
    const sessionRows: Row[] = [
      { path: "/sessions/u/s1.jsonl", text_content: '{"seq":3}', size_bytes: 9, mime_type: "application/json", creation_date: "2026-01-01T00:00:03Z" },
      { path: "/sessions/u/s1.jsonl", text_content: '{"seq":1}', size_bytes: 9, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
      { path: "/sessions/u/s1.jsonl", text_content: '{"seq":2}', size_bytes: 9, mime_type: "application/json", creation_date: "2026-01-01T00:00:02Z" },
    ];

    const client = makeClient([], sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const content = await fs.readFile("/sessions/u/s1.jsonl");
    const lines = content.split("\n");
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).seq).toBe(2);
    expect(JSON.parse(lines[2]).seq).toBe(3);
  });

  it("handles JSONB message (object instead of string)", async () => {
    const sessionRows: Row[] = [
      { path: "/sessions/u/s1.jsonl", text_content: { type: "user_message", content: "hi" } as unknown as string, size_bytes: 30, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
    ];

    const client = makeClient([], sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const content = await fs.readFile("/sessions/u/s1.jsonl");
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("user_message");
    expect(parsed.content).toBe("hi");
  });

  it("lists session files in directory listing", async () => {
    const sessionRows: Row[] = [
      { path: "/sessions/alice/s1.jsonl", text_content: "{}", size_bytes: 2, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
      { path: "/sessions/alice/s2.jsonl", text_content: "{}", size_bytes: 2, mime_type: "application/json", creation_date: "2026-01-01T00:00:02Z" },
    ];

    const client = makeClient([], sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const entries = await fs.readdir("/sessions/alice");
    expect(entries).toContain("s1.jsonl");
    expect(entries).toContain("s2.jsonl");
  });

  it("session paths don't conflict with memory table paths", async () => {
    const memoryRows: Row[] = [
      { path: "/summaries/alice/s1.md", text_content: "# Summary", size_bytes: 9, mime_type: "text/markdown", creation_date: "2026-01-01T00:00:01Z" },
    ];
    const sessionRows: Row[] = [
      { path: "/sessions/alice/s1.jsonl", text_content: '{"type":"user_message"}', size_bytes: 22, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
    ];

    const client = makeClient(memoryRows, sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const summary = await fs.readFile("/summaries/alice/s1.md");
    expect(summary).toBe("# Summary");

    const session = await fs.readFile("/sessions/alice/s1.jsonl");
    expect(JSON.parse(session).type).toBe("user_message");
  });

  it("works without sessions table (backwards compatible)", async () => {
    const memoryRows: Row[] = [
      { path: "/test.txt", text_content: "hello", size_bytes: 5, mime_type: "text/plain", creation_date: "2026-01-01T00:00:01Z" },
    ];

    const client = makeClient(memoryRows);
    // No sessions table passed
    const fs = await DeeplakeFs.create(client as never, "memory", "/");

    const content = await fs.readFile("/test.txt");
    expect(content).toBe("hello");
  });
});

describe("DeeplakeFs — multiple sessions in same table", () => {
  it("different sessions have independent content", async () => {
    const sessionRows: Row[] = [
      { path: "/sessions/u/s1.jsonl", text_content: '{"session":"s1","msg":"hello"}', size_bytes: 30, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
      { path: "/sessions/u/s1.jsonl", text_content: '{"session":"s1","msg":"world"}', size_bytes: 30, mime_type: "application/json", creation_date: "2026-01-01T00:00:02Z" },
      { path: "/sessions/u/s2.jsonl", text_content: '{"session":"s2","msg":"foo"}', size_bytes: 28, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
    ];

    const client = makeClient([], sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");

    const s1 = await fs.readFile("/sessions/u/s1.jsonl");
    const s2 = await fs.readFile("/sessions/u/s2.jsonl");

    expect(s1.split("\n")).toHaveLength(2);
    expect(s2.split("\n")).toHaveLength(1);
    expect(s1).toContain("hello");
    expect(s1).toContain("world");
    expect(s2).toContain("foo");
    expect(s2).not.toContain("hello");
  });
});

describe("session files are read-only", () => {
  async function makeFsWithSession() {
    const sessionRows: Row[] = [
      { path: "/sessions/alice/alice_org_default_s1.jsonl", text_content: '{"type":"user_message"}', size_bytes: 22, mime_type: "application/json", creation_date: "2026-01-01T00:00:01Z" },
    ];
    const memoryRows: Row[] = [
      { path: "/notes.md", text_content: "hello", size_bytes: 5, mime_type: "text/markdown", creation_date: "2026-01-01" },
    ];
    const client = makeClient(memoryRows, sessionRows);
    const fs = await DeeplakeFs.create(client as never, "memory", "/", "sessions");
    return { fs, client };
  }

  it("writeFile rejects session paths with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.writeFile("/sessions/alice/alice_org_default_s1.jsonl", "overwrite"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("appendFile rejects session paths with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.appendFile("/sessions/alice/alice_org_default_s1.jsonl", "append"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("rm rejects session paths with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.rm("/sessions/alice/alice_org_default_s1.jsonl"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("cp rejects session path as destination with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.cp("/notes.md", "/sessions/alice/alice_org_default_s1.jsonl"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("mv rejects session path as source with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.mv("/sessions/alice/alice_org_default_s1.jsonl", "/moved.jsonl"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("mv rejects session path as destination with EPERM", async () => {
    const { fs } = await makeFsWithSession();
    await expect(fs.mv("/notes.md", "/sessions/alice/alice_org_default_s1.jsonl"))
      .rejects.toMatchObject({ code: "EPERM" });
  });

  it("readFile still works on session paths", async () => {
    const { fs } = await makeFsWithSession();
    const content = await fs.readFile("/sessions/alice/alice_org_default_s1.jsonl");
    expect(content).toContain("user_message");
  });

  it("cp from session path as source works (read-only source is fine)", async () => {
    const { fs } = await makeFsWithSession();
    await fs.cp("/sessions/alice/alice_org_default_s1.jsonl", "/copy.jsonl");
    const content = await fs.readFile("/copy.jsonl");
    expect(content).toContain("user_message");
  });
});

describe("ensureSessionsTable schema", () => {
  it("creates table with JSONB message column", async () => {
    const client = {
      query: vi.fn().mockResolvedValue([]),
      listTables: vi.fn().mockResolvedValue([]),
      ensureTable: vi.fn(),
      ensureSessionsTable: vi.fn(),
    };

    // Import and call ensureSessionsTable
    // We test by checking the SQL passed to query
    const { DeeplakeApi } = await import("../../src/deeplake-api.js");
    const api = new DeeplakeApi("token", "https://api.test", "org", "ws", "memory");

    // Mock listTables to return empty (table doesn't exist)
    const origQuery = api.query.bind(api);
    const queryCalls: string[] = [];
    api.query = vi.fn().mockImplementation(async (sql: string) => {
      queryCalls.push(sql);
      return [];
    }) as typeof api.query;
    api.listTables = vi.fn().mockResolvedValue([]) as typeof api.listTables;

    await api.ensureSessionsTable("sessions");

    const createSql = queryCalls.find(s => s.includes("CREATE TABLE"));
    expect(createSql).toBeDefined();
    expect(createSql).toContain("message JSONB");
    expect(createSql).toContain("author TEXT");
    expect(createSql).toContain("application/json");
    // Should NOT have content BYTEA column (sessions don't need binary)
    expect(createSql).not.toContain("BYTEA");
    // Should NOT use old column name
    expect(createSql).not.toContain("content_text");
  });

  it("memory table uses summary column (not content_text)", async () => {
    const { DeeplakeApi } = await import("../../src/deeplake-api.js");
    const api = new DeeplakeApi("token", "https://api.test", "org", "ws", "memory");
    const queryCalls: string[] = [];
    api.query = vi.fn().mockImplementation(async (sql: string) => {
      queryCalls.push(sql);
      return [];
    }) as typeof api.query;
    api.listTables = vi.fn().mockResolvedValue([]) as typeof api.listTables;

    await api.ensureTable();

    const createSql = queryCalls.find(s => s.includes("CREATE TABLE"));
    expect(createSql).toBeDefined();
    expect(createSql).toContain("summary TEXT");
    expect(createSql).toContain("author TEXT");
    expect(createSql).not.toContain("content_text");
    expect(createSql).not.toContain("BYTEA");
  });

  it("memory table migration adds author column", async () => {
    const { DeeplakeApi } = await import("../../src/deeplake-api.js");
    const api = new DeeplakeApi("token", "https://api.test", "org", "ws", "memory");
    const queryCalls: string[] = [];
    api.query = vi.fn().mockImplementation(async (sql: string) => {
      queryCalls.push(sql);
      return [];
    }) as typeof api.query;
    // Table already exists
    api.listTables = vi.fn().mockResolvedValue(["memory"]) as typeof api.listTables;

    await api.ensureTable();

    const alterCalls = queryCalls.filter(s => s.includes("ALTER TABLE"));
    const authorAlter = alterCalls.find(s => s.includes("author"));
    expect(authorAlter).toBeDefined();
  });
});
