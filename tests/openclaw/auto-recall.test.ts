import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression tests for the openclaw `before_agent_start` hook.
 *
 * Design history: the hook used to do a proactive blocking recall query
 * across the memory + sessions tables on every user turn. That made every
 * openclaw turn pay Deeplake's `sessions`-table latency (200ms–10s+) even
 * for prompts that needed no memory at all. Other agents (claude-code,
 * codex, cursor, hermes, pi) don't do this — they let the agent decide
 * when to search by intercepting its Grep tool calls.
 *
 * The hook now mirrors that lazy/agent-initiated pattern: recall is only
 * available via the registered tools (`hivemind_search`, `hivemind_read`,
 * `hivemind_index`), and the SKILL.md body in the system prompt tells the
 * agent to use them. The hook itself still handles two narrow paths that
 * legitimately need to fire before the agent starts:
 *   1. Login nudge — when the user isn't authenticated yet, drop the
 *      device-flow URL into the agent's context so it can show it.
 *   2. Welcome banner — once after a successful device-flow auth.
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

async function loadPluginWithHooks(): Promise<{
  hooks: Map<string, HookHandler>;
  mockApi: ReturnType<typeof buildMockApi>;
}> {
  vi.resetModules();
  const mod = await import("../../openclaw/src/index.js");
  const plugin = mod.default as { register: (api: ReturnType<typeof buildMockApi>) => void };
  const hooks = new Map<string, HookHandler>();
  const mockApi = buildMockApi(hooks);
  plugin.register(mockApi);
  return { hooks, mockApi };
}

function buildMockApi(hooks: Map<string, HookHandler>) {
  return {
    logger: { info: vi.fn(), error: vi.fn() },
    on: (event: string, handler: HookHandler) => { hooks.set(event, handler); },
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerMemoryCorpusSupplement: vi.fn(),
    pluginConfig: {},
  };
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

describe("openclaw before_agent_start (post-blocking-recall removal)", () => {
  it("does NOT call Deeplake on a normal turn — recall is now tool-initiated", async () => {
    // The whole point of removing the proactive recall: a plain turn must
    // not pay Deeplake latency. If this regresses, every openclaw turn
    // will block on `sessions`-table query latency again.
    const { hooks } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "what is Levon doing on accuracy" });

    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("does NOT inject <recalled-memories> context — the agent must call hivemind_search instead", async () => {
    // Even if Deeplake were queried, the old prependContext shape must not
    // be reintroduced. Belt-and-braces: assert the marker text is absent
    // from any return value the hook might emit on a normal turn.
    queryMock.mockResolvedValue([
      { path: "/summaries/alice/abc.md", content: "anything", source_order: 0 },
    ]);
    const { hooks } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    const result = await before({ prompt: "anything that previously triggered recall" });

    const ctx = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(ctx).not.toContain("<recalled-memories>");
  });

  it("still skips when the prompt is empty or too short", async () => {
    const { hooks } = await loadPluginWithHooks();
    const before = hooks.get("before_agent_start")!;
    expect(await before({ prompt: "" })).toBeUndefined();
    expect(await before({ prompt: "hi" })).toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("registers hivemind_search / hivemind_read / hivemind_index tools — recall surface for the agent", async () => {
    // The hook no longer auto-recalls, so the only way the agent gets at
    // memory is the tools. Assert they're still registered; if a future
    // refactor drops them by accident, recall disappears entirely.
    const { mockApi } = await loadPluginWithHooks();
    const registered = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
      ([tool]) => (tool as { name: string }).name,
    );
    expect(registered).toEqual(expect.arrayContaining([
      "hivemind_search", "hivemind_read", "hivemind_index",
    ]));
  });

  it("still surfaces the login URL when the user isn't authenticated yet", async () => {
    // No credentials → getApi() returns null → the hook should prepend the
    // device-flow URL so the agent shows it. This path predates the
    // proactive recall and must survive its removal.
    loadCredsMock.mockReturnValue(null);
    loadConfigMock.mockReturnValue(null);
    const { hooks } = await loadPluginWithHooks();
    // before_agent_start fires asynchronously after register(); requestAuth
    // is kicked off by the post-register login-prompt path with a real URL.
    // We can't easily seed `authUrl` without doing the device flow, so the
    // assertion here is conservative: the hook must NOT call query, and
    // must NOT throw, when no creds exist.
    const before = hooks.get("before_agent_start")!;
    // `.resolves.not.toThrow()` is invalid when the promise resolves to
    // `undefined` (not a function) — see CodeRabbit on #124. Switch to
    // `.resolves.toBeUndefined()` which actually asserts the resolved
    // value and surfaces any thrown rejection naturally.
    await expect(before({ prompt: "anything that triggered the path before" })).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
