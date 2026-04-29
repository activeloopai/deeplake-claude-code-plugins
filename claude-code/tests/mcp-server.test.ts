import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/mcp/server.ts.
 *
 * The module registers three tool handlers on an McpServer instance and
 * connects via stdio. We capture the handler callbacks at registration
 * time (CLAUDE.md rule 5: mock at the boundary) by stubbing McpServer +
 * StdioServerTransport, then invoke each handler directly to drive the
 * unauthenticated, success, and error branches.
 */

const loadCredentialsMock = vi.fn();
const loadConfigMock = vi.fn();
const queryMock = vi.fn();
const searchDeeplakeTablesMock = vi.fn();
const buildGrepSearchOptionsMock = vi.fn();
const normalizeContentMock = vi.fn();
const getVersionMock = vi.fn();
const stderrWriteMock = vi.fn();

const registeredTools = new Map<string, { config: any; handler: (args: any) => Promise<unknown> }>();

vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a),
}));
vi.mock("../../src/config.js", () => ({
  loadConfig: (...a: unknown[]) => loadConfigMock(...a),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
  },
}));
vi.mock("../../src/utils/sql.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/sql.js")>();
  return actual; // use real sqlStr / sqlLike for fidelity
});
vi.mock("../../src/shell/grep-core.js", () => ({
  searchDeeplakeTables: (...a: unknown[]) => searchDeeplakeTablesMock(...a),
  buildGrepSearchOptions: (...a: unknown[]) => buildGrepSearchOptionsMock(...a),
  normalizeContent: (...a: unknown[]) => normalizeContentMock(...a),
}));
vi.mock("../../src/cli/version.js", () => ({
  getVersion: (...a: unknown[]) => getVersionMock(...a),
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    constructor(_meta: unknown) {}
    registerTool(name: string, config: unknown, handler: (args: unknown) => Promise<unknown>) {
      registeredTools.set(name, { config: config as any, handler: handler as any });
    }
    async connect(_transport: unknown) {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

const validConfig = {
  token: "t", apiUrl: "http://example", orgId: "o", orgName: "acme",
  workspaceId: "default", userName: "alice",
  tableName: "memory", sessionsTableName: "sessions",
};

async function importServer(): Promise<void> {
  registeredTools.clear();
  vi.resetModules();
  await import("../../src/mcp/server.js");
  // settle any pending main() side effects
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  loadCredentialsMock.mockReset().mockReturnValue({ token: "t" });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  queryMock.mockReset().mockResolvedValue([]);
  searchDeeplakeTablesMock.mockReset().mockResolvedValue([]);
  buildGrepSearchOptionsMock.mockReset().mockReturnValue({ limit: 10 });
  normalizeContentMock.mockReset().mockImplementation((_p: string, c: string) => c);
  getVersionMock.mockReset().mockReturnValue("9.9.9");
  stderrWriteMock.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderrWriteMock(s); return true; }) as any);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("MCP server — registration shape", () => {
  it("registers exactly the three hivemind tools, named and described", async () => {
    await importServer();
    expect(Array.from(registeredTools.keys()).sort()).toEqual([
      "hivemind_index", "hivemind_read", "hivemind_search",
    ]);
    for (const tool of registeredTools.values()) {
      expect(typeof tool.config.description).toBe("string");
      expect(tool.config.description.length).toBeGreaterThan(20);
    }
  });
});

describe("hivemind_search", () => {
  it("not authenticated → returns the auth-error text", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "x" });
    expect(JSON.stringify(out)).toContain("Not authenticated");
  });

  it("config invalid (creds present but loadConfig null) → 'config could not be loaded'", async () => {
    loadConfigMock.mockReturnValue(null);
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "x" });
    expect(JSON.stringify(out)).toContain("config could not be loaded");
  });

  it("zero rows → returns 'No matches' message", async () => {
    searchDeeplakeTablesMock.mockResolvedValue([]);
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "needle" }) as { content: { text: string }[] };
    expect(out.content[0].text).toBe('No matches for "needle".');
  });

  it("hits → returns one text block joining each row, trimmed to 600 chars per body", async () => {
    searchDeeplakeTablesMock.mockResolvedValue([
      { path: "/summaries/alice/a.md", content: "alpha " + "x".repeat(700) },
      { path: "/summaries/alice/b.md", content: "beta hit" },
    ]);
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "x", limit: 5 }) as { content: { text: string }[] };
    expect(out.content).toHaveLength(1);
    expect(out.content[0].text).toContain("/summaries/alice/a.md");
    expect(out.content[0].text).toContain("/summaries/alice/b.md");
    expect(buildGrepSearchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "x", ignoreCase: true, fixedString: true }),
      "/",
    );
  });

  it("limit defaults to 10 when not provided", async () => {
    await importServer();
    await registeredTools.get("hivemind_search")!.handler({ query: "x" });
    // buildGrepSearchOptions returns {} but the handler then sets opts.limit.
    expect(searchDeeplakeTablesMock).toHaveBeenCalledTimes(1);
    const opts = searchDeeplakeTablesMock.mock.calls[0][3];
    expect(opts.limit).toBe(10);
  });

  it("respects explicit limit when supplied", async () => {
    await importServer();
    await registeredTools.get("hivemind_search")!.handler({ query: "x", limit: 25 });
    const opts = searchDeeplakeTablesMock.mock.calls[0][3];
    expect(opts.limit).toBe(25);
  });

  it("search throws → returns 'Search failed: <msg>'", async () => {
    searchDeeplakeTablesMock.mockRejectedValue(new Error("api 500"));
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "x" });
    expect(JSON.stringify(out)).toContain("Search failed: api 500");
  });
});

describe("hivemind_read", () => {
  it("rejects paths that don't start with '/'", async () => {
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "summaries/x" });
    expect(JSON.stringify(out)).toContain("Path must start with '/'");
  });

  it("/summaries/... path queries the memory table on the summary column", async () => {
    queryMock.mockResolvedValue([{ path: "/summaries/alice/a.md", content: "summary body" }]);
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/summaries/alice/a.md" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0][0] as string)).toContain("summary::text");
    expect(JSON.stringify(out)).toContain("summary body");
  });

  it("/sessions/... path queries the sessions table on the message column", async () => {
    queryMock.mockResolvedValue([{ path: "/sessions/alice/s.jsonl", content: "raw jsonl" }]);
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/sessions/alice/s.jsonl" });
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("message::text");
    expect(JSON.stringify(out)).toContain("raw jsonl");
  });

  it("zero rows → returns 'No content found at <path>'", async () => {
    queryMock.mockResolvedValue([]);
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/summaries/alice/none.md" });
    expect(JSON.stringify(out)).toContain("No content found at /summaries/alice/none.md");
  });

  it("query throws → returns 'Read failed: <msg>'", async () => {
    queryMock.mockRejectedValue(new Error("conn refused"));
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/summaries/x.md" });
    expect(JSON.stringify(out)).toContain("Read failed: conn refused");
  });

  it("not authenticated → auth-error short-circuits before any query", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/summaries/x.md" });
    expect(JSON.stringify(out)).toContain("Not authenticated");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("hivemind_index", () => {
  it("with no prefix: uses the default '/summaries/' filter, default limit=50", async () => {
    queryMock.mockResolvedValue([
      { path: "/summaries/alice/a.md", description: "x", project: "p", last_update_date: "2026-01-01" },
    ]);
    await importServer();
    const out = await registeredTools.get("hivemind_index")!.handler({}) as { content: { text: string }[] };
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("WHERE path LIKE '/summaries/%'");
    expect(sql).toContain("LIMIT 50");
    expect(out.content[0].text.startsWith("path\tlast_updated\tproject\tdescription\n")).toBe(true);
  });

  it("with prefix: uses LIKE '<prefix>%' ESCAPE — wildcard injection guard", async () => {
    // The user-supplied prefix '%' would match every row without ESCAPE +
    // sqlLike escaping the wildcard — assert both protections are present.
    queryMock.mockResolvedValue([]);
    await importServer();
    await registeredTools.get("hivemind_index")!.handler({ prefix: "/summaries/alice/" });
    const sql = queryMock.mock.calls[0][0] as string;
    // Single-backslash ESCAPE clause: SQL string `ESCAPE '\'` is one backslash
    // inside the single-quoted token. Regex needs two backslashes to match it.
    expect(sql).toMatch(/WHERE path LIKE '\/summaries\/alice\/.*%' ESCAPE '\\'/);
  });

  it("respects explicit limit", async () => {
    await importServer();
    await registeredTools.get("hivemind_index")!.handler({ limit: 7 });
    expect((queryMock.mock.calls[0][0] as string)).toContain("LIMIT 7");
  });

  it("zero rows → returns 'No summaries found.'", async () => {
    queryMock.mockResolvedValue([]);
    await importServer();
    const out = await registeredTools.get("hivemind_index")!.handler({});
    expect(JSON.stringify(out)).toContain("No summaries found.");
  });

  it("query throws → returns 'Index failed: <msg>'", async () => {
    queryMock.mockRejectedValue(new Error("schema migration in progress"));
    await importServer();
    const out = await registeredTools.get("hivemind_index")!.handler({});
    expect(JSON.stringify(out)).toContain("Index failed: schema migration in progress");
  });

  it("renders each row as tab-separated path / date / project / description", async () => {
    queryMock.mockResolvedValue([
      { path: "/summaries/alice/a.md", description: "Alice's first session", project: "ml", last_update_date: "2026-04-01" },
    ]);
    await importServer();
    const out = await registeredTools.get("hivemind_index")!.handler({}) as { content: { text: string }[] };
    expect(out.content[0].text).toContain("/summaries/alice/a.md\t2026-04-01\tml\tAlice's first session");
  });
});

describe("error-message coercion (non-Error rejections)", () => {
  // Source uses `err instanceof Error ? err.message : String(err)` — exercise
  // the String(err) branch by rejecting with a non-Error value.

  it("hivemind_search: a string-rejection becomes 'Search failed: <string>'", async () => {
    searchDeeplakeTablesMock.mockRejectedValue("string-rejection");
    await importServer();
    const out = await registeredTools.get("hivemind_search")!.handler({ query: "x" }) as { content: { text: string }[] };
    expect(out.content[0].text).toContain("Search failed: string-rejection");
  });

  it("hivemind_read: a string-rejection becomes 'Read failed: <string>'", async () => {
    queryMock.mockRejectedValue("read-string-rejection");
    await importServer();
    const out = await registeredTools.get("hivemind_read")!.handler({ path: "/summaries/x.md" }) as { content: { text: string }[] };
    expect(out.content[0].text).toContain("Read failed: read-string-rejection");
  });

  it("hivemind_index: a string-rejection becomes 'Index failed: <string>'", async () => {
    queryMock.mockRejectedValue("index-string-rejection");
    await importServer();
    const out = await registeredTools.get("hivemind_index")!.handler({}) as { content: { text: string }[] };
    expect(out.content[0].text).toContain("Index failed: index-string-rejection");
  });
});
