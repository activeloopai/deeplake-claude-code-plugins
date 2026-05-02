import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const loadCredentialsMock = vi.fn();
const debugLogMock = vi.fn();
const queryMock = vi.fn();
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
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
    ensureTable(...a: unknown[]) { return ensureTableMock(...a); }
    ensureSessionsTable(...a: unknown[]) { return ensureSessionsTableMock(...a); }
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
  await import("../../src/hooks/hermes/session-start.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({ session_id: "ses-1", cwd: "/proj" });
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

describe("hermes session-start hook — guards", () => {
  it("HIVEMIND_WIKI_WORKER=1 → no stdin read, no console output", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
    expect(consoleLogMock).not.toHaveBeenCalled();
  });
});

describe("hermes session-start hook — placeholder creation", () => {
  it("INSERTs a placeholder when none exists yet", async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT
    queryMock.mockResolvedValueOnce([]); // INSERT
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(2);
    const insertSql = queryMock.mock.calls[1][0] as string;
    expect(insertSql).toMatch(/INSERT INTO "memory"/);
    expect(insertSql).toContain("'hermes'");
    expect(insertSql).toContain("/summaries/alice/ses-1.md");
  });

  it("skips INSERT when placeholder already exists", async () => {
    queryMock.mockResolvedValueOnce([{ path: "/summaries/alice/ses-1.md" }]);
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("skipped entirely when no token", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("skipped when HIVEMIND_CAPTURE=false", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("DB error is swallowed and logged (does not crash the hook)", async () => {
    queryMock.mockRejectedValue(new Error("net err"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("placeholder failed"));
    // context still emitted
    expect(consoleLogMock).toHaveBeenCalled();
  });
});

describe("hermes session-start hook — context payload", () => {
  it("logged-in branch: emits {context: ...} with the org line + version notice", async () => {
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.context).toContain("DEEPLAKE MEMORY");
    expect(payload.context).toContain("Logged in to Deeplake as org: acme");
    expect(payload.context).toContain("Hivemind v0.7.0");
    // Hermes uses 'context' not 'additional_context' (Cursor's key).
    expect(payload.additional_context).toBeUndefined();
  });

  it("not-logged-in branch links to the auth-login command", async () => {
    loadCredentialsMock.mockReturnValue(null);
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.context).toContain("Not logged in to Deeplake");
    expect(payload.context).toContain("auth-login.js");
  });

  it("falls back to orgId in the org line when orgName is missing", async () => {
    loadCredentialsMock.mockReturnValue({ token: "t", orgId: "o-99" });
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.context).toContain("org: o-99");
  });

  it("omits the version notice when getInstalledVersion returns null", async () => {
    getInstalledVersionMock.mockReturnValue(null);
    await runHook();
    const payload = JSON.parse(consoleLogMock.mock.calls[0][0] as string);
    expect(payload.context).not.toContain("Hivemind v");
  });

  it("synthesises 'hermes-<ts>' session id when session_id is missing", async () => {
    stdinMock.mockResolvedValue({ cwd: "/proj" });
    await runHook();
    const insertSql = queryMock.mock.calls[1]?.[0] as string;
    expect(insertSql ?? "").toMatch(/\/summaries\/alice\/hermes-\d+\.md/);
  });

  it("readStdin throwing → top-level catch arrow logs 'fatal' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin gone"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin gone"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
