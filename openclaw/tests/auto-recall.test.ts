import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Auto-recall regression tests for the openclaw hivemind plugin's
 * `before_agent_start` hook. This used to do a single-keyword ILIKE on the
 * sessions table only; after the Phase-1 fix it calls `searchDeeplakeTables`
 * with multi-word patterns across BOTH the memory (summaries) and sessions
 * tables, exactly what CC/Codex agents see via their PreToolUse grep path.
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

type HookHandler = (event: Record<string, unknown>) => Promise<unknown>;

async function loadPluginWithHooks() {
  vi.resetModules();
  const mod = await import("../src/index.js");
  const plugin = mod.default as { register: (api: any) => void };
  const hooks = new Map<string, HookHandler>();
  const mockApi = {
    logger: { info: vi.fn(), error: vi.fn() },
    on: (event: string, handler: HookHandler) => { hooks.set(event, handler); },
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerMemoryCorpusSupplement: vi.fn(),
    pluginConfig: {},
  };
  plugin.register(mockApi);
  return { hooks, mockApi };
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

describe("openclaw auto-recall (before_agent_start)", () => {
  it("skips when the prompt is too short", async () => {
    const { hooks } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "hi" });
    expect(result).toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("runs a multi-word UNION ALL search across memory and sessions", async () => {
    queryMock.mockResolvedValue([
      { path: "/summaries/alice/abc.md", content: "Levon is driving the LoCoMo accuracy work", source_order: 0, creation_date: "" },
      { path: "/sessions/bob/xyz.jsonl", content: "chatted with Levon about accuracy metrics", source_order: 1, creation_date: "2026-04-22" },
    ]);
    const { hooks, mockApi } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "what is Levon doing on accuracy" });

    expect(queryMock).toHaveBeenCalled();
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain('FROM "memory"');
    expect(sql).toContain('FROM "sessions"');
    expect(sql).toContain("UNION ALL");
    // Multi-keyword match — at least "levon" and "accuracy" both appear as OR filters
    expect(sql).toMatch(/summary::text ILIKE '%levon%'/i);
    expect(sql).toMatch(/summary::text ILIKE '%accuracy%'/i);
    expect(sql).toMatch(/message::text ILIKE '%levon%'/i);
    expect(sql).toMatch(/message::text ILIKE '%accuracy%'/i);

    const ctx = (result as { prependContext: string }).prependContext;
    expect(ctx).toContain("<recalled-memories>");
    expect(ctx).toContain("/summaries/alice/abc.md");
    expect(ctx).toContain("/sessions/bob/xyz.jsonl");
    expect(ctx).toContain("</recalled-memories>");
    expect(mockApi.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Auto-recalled 2 memories"),
    );
  });

  it("returns undefined when no rows match", async () => {
    queryMock.mockResolvedValue([]);
    const { hooks } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "what is nobody-ever-mentioned doing" });
    expect(result).toBeUndefined();
  });

  it("logs and returns undefined when the DeeplakeApi throws", async () => {
    queryMock.mockRejectedValue(new Error("deeplake down"));
    const { hooks, mockApi } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "what is levon doing" });
    expect(result).toBeUndefined();
    expect(mockApi.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Auto-recall failed"),
    );
  });
});
