import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const loadCredentialsMock = vi.fn();
const debugLogMock = vi.fn();
const queryMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const consoleLogMock = vi.fn();
const getInstalledVersionMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({ loadCredentials: (...a: unknown[]) => loadCredentialsMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/utils/version-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/version-check.js")>();
  return { ...actual, getInstalledVersion: (...a: unknown[]) => getInstalledVersionMock(...a) };
});
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
    ensureTable() { return ensureTableMock(); }
    ensureSessionsTable(t: string) { return ensureSessionsTableMock(t); }
  },
}));

const validConfig = {
  token: "t", apiUrl: "http://example", orgId: "o", orgName: "acme",
  workspaceId: "default", userName: "alice",
  tableName: "memory", sessionsTableName: "sessions",
};

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_CAPTURE;
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/cursor/session-start.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", workspace_roots: ["/tmp/proj"] });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  loadCredentialsMock.mockReset().mockReturnValue({ token: "t", orgName: "acme", workspaceId: "default" });
  debugLogMock.mockReset();
  queryMock.mockReset().mockResolvedValue([]);
  ensureTableMock.mockReset().mockResolvedValue(undefined);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  consoleLogMock.mockReset();
  getInstalledVersionMock.mockReset().mockReturnValue("0.7.0");
  vi.spyOn(console, "log").mockImplementation(((s: string) => { consoleLogMock(s); }) as any);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("cursor session-start hook — guards", () => {
  it("HIVEMIND_WIKI_WORKER=1 → no stdin read, no console output", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
    expect(consoleLogMock).not.toHaveBeenCalled();
  });
});

describe("cursor session-start hook — placeholder creation", () => {
  it("calls ensureTable + ensureSessionsTable + INSERT when no placeholder exists", async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT path returns empty (no placeholder yet)
    queryMock.mockResolvedValueOnce([]); // INSERT
    await runHook();
    expect(ensureTableMock).toHaveBeenCalledTimes(1);
    expect(ensureSessionsTableMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
    const insertSql = queryMock.mock.calls[1][0] as string;
    expect(insertSql).toMatch(/INSERT INTO "memory"/);
    expect(insertSql).toContain("'cursor'");
    expect(insertSql).toContain("/summaries/alice/sid-1.md");
  });

  it("skips INSERT when placeholder already exists", async () => {
    queryMock.mockResolvedValueOnce([{ path: "/summaries/alice/sid-1.md" }]);
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1); // only the SELECT, no INSERT
  });

  it("skips placeholder when HIVEMIND_CAPTURE=false", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("skips placeholder when no token in credentials", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("placeholder DB error is swallowed and logged (does not crash the hook)", async () => {
    queryMock.mockRejectedValue(new Error("network down"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("placeholder failed"));
    // additional_context is still emitted to stdout.
    expect(consoleLogMock).toHaveBeenCalled();
  });
});

describe("cursor session-start hook — additional_context payload", () => {
  it("logged-in branch: includes 'Logged in to Deeplake' line plus the version notice", async () => {
    await runHook();
    const json = consoleLogMock.mock.calls[0][0] as string;
    const payload = JSON.parse(json);
    expect(payload.additional_context).toContain("DEEPLAKE MEMORY");
    expect(payload.additional_context).toContain("Logged in to Deeplake as org: acme");
    expect(payload.additional_context).toContain("Hivemind v0.7.0");
  });

  it("not-logged-in branch: links to the auth-login command instead of the org line", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.additional_context).toContain("Not logged in to Deeplake");
    expect(payload.additional_context).toContain("auth-login.js");
  });

  it("falls back to orgId in the org-line when orgName is missing", async () => {
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o-99" });
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.additional_context).toContain("org: o-99");
  });

  it("omits the version notice when getInstalledVersion returns null", async () => {
    getInstalledVersionMock.mockReturnValue(null);
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.additional_context).not.toContain("Hivemind v");
  });

  it("uses conversation_id as the session id when session_id is missing", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "conv-only", workspace_roots: ["/p"] });
    await runHook();
    const insertSql = queryMock.mock.calls[1]?.[0] as string;
    expect(insertSql ?? "").toContain("/summaries/alice/conv-only.md");
  });

  it("synthesises a 'cursor-<ts>' session id when neither session_id nor conversation_id are present", async () => {
    stdinMock.mockResolvedValue({ workspace_roots: ["/p"] });
    await runHook();
    const insertSql = queryMock.mock.calls[1]?.[0] as string;
    expect(insertSql ?? "").toMatch(/\/summaries\/alice\/cursor-\d+\.md/);
  });

  it("readStdin throwing → top-level catch arrow logs 'fatal' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin gone"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin gone"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
