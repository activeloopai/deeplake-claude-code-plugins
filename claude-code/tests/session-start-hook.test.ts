import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Direct source-level tests for src/hooks/session-start.ts. The hook
 * orchestrates: credential load, userName backfill, table+placeholder
 * setup, version check + auto-update, and the additionalContext output.
 *
 * Mocks: readStdin, loadCredentials/saveCredentials, loadConfig,
 * DeeplakeApi, global.fetch, child_process.execSync, and the two
 * node:fs helpers used by the cache-cleanup path (readdirSync, rmSync).
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const saveCredsMock = vi.fn();
const loginMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const queryMock = vi.fn();
const execSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: any[]) => loadCredsMock(...a),
  saveCredentials: (...a: any[]) => saveCredsMock(...a),
  login: (...a: any[]) => loginMock(...a),
}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: any[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_t: string, msg: string) => debugLogMock(msg),
  utcTimestamp: () => "2026-04-17 00:00:00 UTC",
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
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readdirSync: (...a: any[]) => readdirSyncMock(...a),
    rmSync: (...a: any[]) => rmSyncMock(...a),
  };
});

const originalFetch = global.fetch;
const fetchMock = vi.fn();

let stdoutLines: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write");

async function runHook(env: Record<string, string | undefined> = {}): Promise<string | null> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  delete process.env.HIVEMIND_CAPTURE;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stdoutLines = [];
  stdoutSpy.mockImplementation((chunk: any) => { stdoutLines.push(String(chunk)); return true; });
  vi.resetModules();
  // @ts-expect-error
  global.fetch = fetchMock;
  // Intercept console.log which session-start.ts uses for the JSON emit
  const originalLog = console.log;
  const collected: string[] = [];
  console.log = (...args: any[]) => { collected.push(args.join(" ")); };
  try {
    await import("../../src/hooks/session-start.js");
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    return collected.join("\n") || null;
  } finally {
    console.log = originalLog;
  }
}

const validConfig = {
  token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
  userName: "alice", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

let cacheTmp: string;

beforeEach(() => {
  cacheTmp = mkdtempSync(join(tmpdir(), "session-start-test-"));
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", cwd: "/workspaces/proj" });
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "o", orgName: "acme", userName: "alice", workspaceId: "default",
  });
  saveCredsMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  ensureTableMock.mockReset().mockResolvedValue(undefined);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  queryMock.mockReset().mockResolvedValue([]); // "no existing summary"
  execSyncMock.mockReset();
  readdirSyncMock.mockReset().mockReturnValue([]);
  rmSyncMock.mockReset();
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ version: "0.0.1" }), // older-or-equal → no update
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error
  global.fetch = originalFetch;
  try { rmSync(cacheTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═══ Guard + credential branches ═══════════════════════════════════════════

describe("session-start hook — guards", () => {
  it("returns immediately when HIVEMIND_WIKI_WORKER=1", async () => {
    const out = await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("emits additionalContext with the not-logged-in warning when no creds", async () => {
    loadCredsMock.mockReturnValue(null);
    const out = await runHook();
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Not logged in to Deeplake");
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("no credentials found"),
    );
  });

  it("emits the logged-in context when creds are present", async () => {
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Logged in to Deeplake as org: acme");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("workspace: default");
  });

  it("falls back to orgId when orgName is missing", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "org-uuid", userName: "u", workspaceId: "default",
    });
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Logged in to Deeplake as org: org-uuid");
  });

  it("backfills userName via node:os when credentials lack one", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
    });
    await runHook();
    expect(saveCredsMock).toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringMatching(/^backfilled and persisted userName: /),
    );
  });
});

// ═══ Table setup + placeholder ═════════════════════════════════════════════

describe("session-start hook — placeholder branching", () => {
  it("creates placeholder when summary does not exist (query returns [])", async () => {
    await runHook();
    expect(ensureTableMock).toHaveBeenCalled();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    // 1 SELECT (existing check) + 1 INSERT = 2 queries.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toMatch(/^SELECT path FROM/);
    expect(queryMock.mock.calls[1][0]).toMatch(/^INSERT INTO/);
    expect(debugLogMock).toHaveBeenCalledWith("placeholder created");
  });

  it("skips placeholder INSERT when summary already exists (resumed session)", async () => {
    queryMock.mockResolvedValueOnce([{ path: "/summaries/alice/sid-1.md" }]);
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1); // only the SELECT
  });

  it("skips placeholder INSERT when HIVEMIND_CAPTURE=false but still ensures tables", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(ensureTableMock).toHaveBeenCalled();
    expect(ensureSessionsTableMock).toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      "placeholder skipped (HIVEMIND_CAPTURE=false)",
    );
  });

  it("swallows placeholder errors and logs via both loggers", async () => {
    ensureTableMock.mockRejectedValue(new Error("table boom"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("placeholder failed: table boom"),
    );
  });

  it("skips setup when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });

  it("skips setup when session_id is empty", async () => {
    stdinMock.mockResolvedValue({ session_id: "", cwd: "/x" });
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });
});

// ═══ Version check + autoupdate ═════════════════════════════════════════════

describe("session-start hook — version check", () => {
  it("runs execSync and cleans old cache entries when a newer version is available", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0" }),
    });
    readdirSyncMock.mockReturnValue([
      { name: "0.0.1", isDirectory: () => true },
      { name: "999.0.0", isDirectory: () => true }, // latest, must NOT be removed
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = await runHook();
    expect(execSyncMock).toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
    expect(rmSyncMock.mock.calls[0][0]).toContain("0.0.1");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("auto-updated"));
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("auto-updated");
  });

  it("falls back to manual-upgrade message when autoupdate is disabled", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "o", orgName: "acme", userName: "u", workspaceId: "default",
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

  it("emits the 'auto-update failed' message when execSync throws", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "999.0.0" }) });
    execSyncMock.mockImplementation(() => { throw new Error("npm unreachable"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-update failed"),
    );
  });

  it("tolerates fetch failure (GitHub unreachable)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("tolerates readdirSync throw during cache cleanup", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "999.0.0" }) });
    readdirSyncMock.mockImplementation(() => { throw new Error("readdir boom"); });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("cache cleanup failed: readdir boom"),
    );
  });

  it("emits 'up to date' context when latest == current", async () => {
    // Real getInstalledVersion reads plugin.json from the real repo; we
    // simulate "latest equals current" by returning the same version.
    // Since we don't know the installed version at runtime, we use
    // readFileSync-based indirection: fetchMock returns a version that
    // is definitely older (0.0.1). The file read picks up the repo's
    // real version → latest 0.0.1 is NOT newer → "up to date" branch.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "0.0.1" }) });
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("up to date");
  });
});

// ═══ Fatal catch ════════════════════════════════════════════════════════════

describe("session-start hook — fatal catch", () => {
  it("catches a stdin throw and exits 0", async () => {
    stdinMock.mockRejectedValue(new Error("bad stdin"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: bad stdin");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Additional branch coverage
describe("session-start hook — version helpers edge cases", () => {
  it("fetch ok:false short-circuits getLatestVersion (no autoupdate)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ version: "999.0.0" }) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("GitHub response without a version field falls through to null", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("workspaceId missing on creds falls back to 'default' in context", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "o", orgName: "acme", userName: "alice",
      // workspaceId omitted
    });
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("workspace: default");
  });
});
