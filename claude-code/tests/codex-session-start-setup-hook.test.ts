import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/hooks/codex/session-start-setup.ts. The
 * codex async setup hook does the same work as its claude-code
 * counterpart (table setup, placeholder, version check + autoupdate)
 * but with a different autoupdate strategy — it runs a shell pipeline
 * that git clones the release tag into the codex plugin cache.
 *
 * Mocks: readStdin, loadCredentials/saveCredentials, loadConfig,
 * DeeplakeApi (ensureTable, ensureSessionsTable, query), global.fetch,
 * child_process.execSync.
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const saveCredsMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const queryMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: any[]) => loadCredsMock(...a),
  saveCredentials: (...a: any[]) => saveCredsMock(...a),
}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: any[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_t: string, msg: string) => debugLogMock(msg),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    ensureTable() { return ensureTableMock(); }
    ensureSessionsTable(t: string) { return ensureSessionsTableMock(t); }
    query(sql: string) { return queryMock(sql); }
  },
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: (...a: any[]) => execSyncMock(...a) };
});

const originalFetch = global.fetch;
const fetchMock = vi.fn();

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  delete process.env.HIVEMIND_CAPTURE;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  // @ts-expect-error
  global.fetch = fetchMock;
  await import("../../src/hooks/codex/session-start-setup.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
  userName: "alice", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({
    session_id: "sid-1", cwd: "/workspaces/proj",
    hook_event_name: "SessionStart", model: "gpt-5",
  });
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "o", orgName: "acme", userName: "alice",
  });
  saveCredsMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  ensureTableMock.mockReset().mockResolvedValue(undefined);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  queryMock.mockReset().mockResolvedValue([]); // placeholder SELECT → empty, INSERT will follow
  execSyncMock.mockReset();
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ version: "0.0.1" }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error
  global.fetch = originalFetch;
});

describe("codex session-start-setup hook — guards", () => {
  it("returns when HIVEMIND_WIKI_WORKER=1", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("returns when no credentials are loaded", async () => {
    loadCredsMock.mockReturnValue(null);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no credentials");
    expect(ensureTableMock).not.toHaveBeenCalled();
  });
});

describe("codex session-start-setup hook — userName backfill", () => {
  it("backfills userName when missing and saves creds", async () => {
    loadCredsMock.mockReturnValue({ token: "tok", orgId: "o", orgName: "acme" });
    await runHook();
    expect(saveCredsMock).toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringMatching(/^backfilled userName: /),
    );
  });

  it("does not save when userName present", async () => {
    await runHook();
    expect(saveCredsMock).not.toHaveBeenCalled();
  });
});

describe("codex session-start-setup hook — placeholder branching", () => {
  it("creates placeholder when none exists (SELECT returns [] → INSERT)", async () => {
    await runHook();
    expect(ensureTableMock).toHaveBeenCalled();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toMatch(/^SELECT path FROM/);
    expect(queryMock.mock.calls[1][0]).toMatch(/^INSERT INTO/);
    expect(queryMock.mock.calls[1][0]).toContain("'codex'");
    expect(debugLogMock).toHaveBeenCalledWith("setup complete");
  });

  it("skips INSERT on resumed session (SELECT returns a row)", async () => {
    queryMock.mockResolvedValueOnce([{ path: "/summaries/alice/sid-1.md" }]);
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("skips placeholder when HIVEMIND_CAPTURE=false but still ensures tables", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(ensureTableMock).toHaveBeenCalled();
    expect(ensureSessionsTableMock).toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("swallows setup errors and logs them", async () => {
    ensureTableMock.mockRejectedValue(new Error("table boom"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("setup failed: table boom"),
    );
  });

  it("skips setup when session_id is empty", async () => {
    stdinMock.mockResolvedValue({
      session_id: "", cwd: "/x", hook_event_name: "SessionStart", model: "m",
    });
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });

  it("skips setup when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });
});

describe("codex session-start-setup hook — version check + autoupdate", () => {
  it("runs the git-clone autoupdate when a newer version is available", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0" }),
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(execSyncMock).toHaveBeenCalled();
    // The shell pipeline builds the tag from the version — verify the
    // safe version regex accepted it and the tag embedded.
    expect(execSyncMock.mock.calls[0][0]).toContain("v999.0.0");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("auto-updated"),
    );
  });

  it("uses the manual-upgrade message when autoupdate is disabled", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "o", orgName: "acme", userName: "u",
      autoupdate: false,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "999.0.0" }) });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("update available"),
    );
  });

  it("emits 'Auto-update failed' when execSync throws", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "999.0.0" }) });
    execSyncMock.mockImplementation(() => { throw new Error("git fail"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-update failed"),
    );
  });

  it("tolerates a fetch error (GitHub unreachable)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});

describe("codex session-start-setup hook — fatal catch", () => {
  it("catches stdin throw and exits 0", async () => {
    stdinMock.mockRejectedValue(new Error("stdin boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: stdin boom");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Additional branch coverage for version helpers
describe("codex session-start-setup hook — version helpers edge cases", () => {
  it("fetch ok:false short-circuits getLatestVersion", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ version: "999.0.0" }) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("response without 'version' field falls through to null", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe version tags without executing git clone", async () => {
    // The hook builds `v${latest}` and validates against /^v\d+\.\d+\.\d+$/.
    // Feed a version that fails the regex; the inner try throws the
    // 'unsafe version tag' guard error, which is caught and surfaces
    // the manual-upgrade path.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0-dangerous;rm -rf" }),
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-update failed"),
    );
  });

  it("treats latest == current as 'up to date' (isNewer false)", async () => {
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", ".claude-plugin", "plugin.json"),
        "utf-8",
      ),
    );
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: pkg.version }) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
