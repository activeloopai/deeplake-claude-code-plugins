import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration tests for the three agent-facing memory tools registered by the
 * openclaw hivemind plugin (hivemind_search, hivemind_read, hivemind_index).
 *
 * The tools route through the same search/read primitives the claude-code and
 * codex PreToolUse hooks use, so these tests mock DeeplakeApi at the SQL-query
 * boundary and assert that queries target BOTH the memory (summaries) and
 * sessions (raw turns) tables — the key accuracy gap we're closing.
 */

const queryMock = vi.fn();
const listTablesMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const loadConfigMock = vi.fn();
const loadCredsMock = vi.fn();

vi.mock("../../src/config.js", () => ({ loadConfig: () => loadConfigMock() }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: () => loadCredsMock(),
  saveCredentials: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
  listOrgs: vi.fn().mockResolvedValue([]),
  switchOrg: vi.fn(),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  switchWorkspace: vi.fn(),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
    listTables() { return listTablesMock(); }
    ensureSessionsTable(n: string) { return ensureSessionsTableMock(n); }
    ensureTable() { return Promise.resolve(); }
  },
}));

type MockTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string | undefined,
    rawParams: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

async function loadPluginWithTools() {
  vi.resetModules();
  const mod = await import("../src/index.js");
  const plugin = mod.default as { register: (api: any) => void };
  const tools: MockTool[] = [];
  const mockApi = {
    logger: { info: vi.fn(), error: vi.fn() },
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: (tool: MockTool) => { tools.push(tool); },
    registerMemoryCorpusSupplement: vi.fn(),
  };
  plugin.register(mockApi);
  return { plugin, tools, mockApi };
}

beforeEach(() => {
  queryMock.mockReset();
  listTablesMock.mockReset().mockResolvedValue(["memory", "sessions"]);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "o", orgName: "acme", userName: "alice",
  });
  loadConfigMock.mockReset().mockReturnValue({
    token: "tok",
    orgId: "o",
    orgName: "acme",
    userName: "alice",
    workspaceId: "hivemind",
    apiUrl: "http://example",
    tableName: "memory",
    sessionsTableName: "sessions",
    memoryPath: "/tmp/mem",
  });
});

describe("openclaw hivemind tools — registration", () => {
  it("registers hivemind_search, hivemind_read, hivemind_index when host exposes registerTool", async () => {
    const { tools } = await loadPluginWithTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "hivemind_index",
      "hivemind_read",
      "hivemind_search",
    ]);
  });

  it("skips tool registration when host does not expose registerTool", async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    const plugin = mod.default as { register: (api: any) => void };
    let threw: unknown = null;
    try {
      plugin.register({
        logger: { info: vi.fn(), error: vi.fn() },
        on: vi.fn(),
        registerCommand: vi.fn(),
        // registerTool intentionally omitted
      });
    } catch (e) { threw = e; }
    expect(threw).toBeNull();
  });

  it("registers memoryCorpusSupplement when host exposes it", async () => {
    const supplementMock = vi.fn();
    vi.resetModules();
    const mod = await import("../src/index.js");
    const plugin = mod.default as { register: (api: any) => void };
    plugin.register({
      logger: { info: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerMemoryCorpusSupplement: supplementMock,
    });
    expect(supplementMock).toHaveBeenCalledTimes(1);
    const arg = supplementMock.mock.calls[0][0];
    expect(typeof arg.search).toBe("function");
    expect(typeof arg.get).toBe("function");
  });
});

describe("hivemind_search", () => {
  it("issues a UNION ALL query across memory and sessions tables", async () => {
    queryMock.mockResolvedValue([
      { path: "/summaries/alice.md", content: "Levon is building the plugin", source_order: 0, creation_date: "2026-04-22" },
      { path: "/sessions/bob/abc.jsonl", content: "talked about Levon's PR", source_order: 1, creation_date: "2026-04-22" },
    ]);
    const { tools } = await loadPluginWithTools();
    const search = tools.find(t => t.name === "hivemind_search")!;
    const result = await search.execute("call-1", { query: "Levon" });

    expect(queryMock).toHaveBeenCalled();
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain('FROM "memory"');
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("UNION ALL");

    const text = result.content[0].text;
    expect(text).toContain("/summaries/alice.md");
    expect(text).toContain("/sessions/bob/abc.jsonl");
    expect((result.details as { hits: number }).hits).toBe(2);
  });

  it("uses multi-word OR filter when query has multiple tokens", async () => {
    queryMock.mockResolvedValue([]);
    const { tools } = await loadPluginWithTools();
    const search = tools.find(t => t.name === "hivemind_search")!;
    await search.execute("call-2", { query: "Levon accuracy locomo" });
    const sql = queryMock.mock.calls[0][0];
    // multi-word LIKE clauses on both memory.summary::text AND sessions.message::text
    expect(sql).toMatch(/summary::text ILIKE '%levon%'/i);
    expect(sql).toMatch(/summary::text ILIKE '%accuracy%'/i);
    expect(sql).toMatch(/summary::text ILIKE '%locomo%'/i);
    expect(sql).toMatch(/message::text ILIKE '%levon%'/i);
    expect(sql).toMatch(/message::text ILIKE '%accuracy%'/i);
    expect(sql).toMatch(/message::text ILIKE '%locomo%'/i);
  });

  it("scopes to targetPath when path arg is provided", async () => {
    queryMock.mockResolvedValue([]);
    const { tools } = await loadPluginWithTools();
    const search = tools.find(t => t.name === "hivemind_search")!;
    await search.execute("call-3", { query: "levon", path: "/summaries/" });
    const sql = queryMock.mock.calls[0][0];
    // builder emits an equality clause for the dir itself plus a LIKE for children
    expect(sql).toContain("path = '/summaries'");
    expect(sql).toContain("path LIKE '/summaries/%'");
  });

  it("returns 'No memory matches' on empty result set", async () => {
    queryMock.mockResolvedValue([]);
    const { tools } = await loadPluginWithTools();
    const search = tools.find(t => t.name === "hivemind_search")!;
    const result = await search.execute("call-4", { query: "definitely-not-a-word" });
    expect(result.content[0].text).toContain("No memory matches");
  });

  it("returns a friendly error when DeeplakeApi throws", async () => {
    queryMock.mockRejectedValue(new Error("network down"));
    const { tools, mockApi } = await loadPluginWithTools();
    const search = tools.find(t => t.name === "hivemind_search")!;
    const result = await search.execute("call-5", { query: "x" });
    expect(result.content[0].text).toMatch(/Search failed/);
    expect(mockApi.logger.error).toHaveBeenCalled();
  });
});

describe("hivemind_read", () => {
  it("fetches content via the virtual-table read path (queries both tables)", async () => {
    queryMock.mockResolvedValue([
      { path: "/summaries/alice.md", content: "# session summary", source_order: 0 },
    ]);
    const { tools } = await loadPluginWithTools();
    const read = tools.find(t => t.name === "hivemind_read")!;
    const result = await read.execute("call-6", { path: "/summaries/alice.md" });

    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain('FROM "memory"');
    expect(sql).toContain('FROM "sessions"');
    expect(result.content[0].text).toBe("# session summary");
  });

  it("returns 'No content' when the path does not exist", async () => {
    queryMock.mockResolvedValue([]);
    const { tools } = await loadPluginWithTools();
    const read = tools.find(t => t.name === "hivemind_read")!;
    const result = await read.execute("call-7", { path: "/summaries/missing.md" });
    expect(result.content[0].text).toMatch(/No content/);
  });
});

describe("hivemind_index", () => {
  it("builds the memory index from both summary and session rows", async () => {
    queryMock
      // First call (inside readVirtualPathContents) looks for /index.md in both tables → empty.
      .mockResolvedValueOnce([])
      // Then the /index.md fallback path issues two queries for the index build.
      .mockResolvedValueOnce([
        { path: "/summaries/alice/abc.md", project: "openclaw-coexist", description: "Debugging hivemind coexistence", creation_date: "2026-04-22T12:00:00Z" },
      ])
      .mockResolvedValueOnce([
        { path: "/sessions/alice/alice_o_ws_xyz.jsonl", description: "Telegram session" },
      ]);
    const { tools } = await loadPluginWithTools();
    const index = tools.find(t => t.name === "hivemind_index")!;
    const result = await index.execute(undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("# Memory Index");
    expect(text).toContain("/summaries/alice/abc.md");
    expect(text).toContain("/sessions/alice/alice_o_ws_xyz.jsonl");
    expect(text).toContain("1 summaries");
    expect(text).toContain("1 sessions");
  });
});
