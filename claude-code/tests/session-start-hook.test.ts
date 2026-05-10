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
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const queryMock = vi.fn();
const autoUpdateMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: any[]) => loadCredsMock(...a),
  saveCredentials: (...a: any[]) => saveCredsMock(...a),
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
// autoUpdate mocked at the boundary (CLAUDE.md rule 5) — the helper
// itself is exhaustively tested in autoupdate.test.ts. Here we only
// assert the hook *called* it with the right agent id and *didn't*
// re-introduce the legacy execSync/snapshot/marketplace path.
vi.mock("../../src/hooks/shared/autoupdate.js", () => ({
  autoUpdate: (...a: any[]) => autoUpdateMock(...a),
}));

// getInstalledVersion mocked so we can drive the "version notice" branch
// in additionalContext deterministically (returns a value vs null). The
// real implementation walks the fs and would always return the repo's
// package.json version, leaving the null branch uncovered.
const getInstalledVersionMock = vi.fn();
vi.mock("../../src/utils/version-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/version-check.js")>();
  return { ...actual, getInstalledVersion: (...a: unknown[]) => getInstalledVersionMock(...a) };
});

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
  autoUpdateMock.mockReset().mockResolvedValue(undefined);
  getInstalledVersionMock.mockReset().mockReturnValue("9.9.9");
  // Disable auto-pull during this test: autoPullSkills would otherwise issue
  // an extra SQL query (against `skills`) through the same DeeplakeApi mock,
  // breaking the placeholder-branching call-count assertions. The auto-pull
  // module's behaviour is covered exhaustively in skillify-auto-pull.test.ts.
  process.env.HIVEMIND_AUTOPULL_DISABLED = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HIVEMIND_AUTOPULL_DISABLED;
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

// ═══ Centralized autoupdate ═════════════════════════════════════════════════

describe("session-start hook — centralized autoupdate", () => {
  // The autoUpdate helper itself is exhaustively tested in autoupdate.test.ts.
  // Here we only verify the hook wires it up correctly.

  it("invokes autoUpdate exactly once with agent: 'claude'", async () => {
    await runHook();
    expect(autoUpdateMock).toHaveBeenCalledTimes(1);
    expect(autoUpdateMock.mock.calls[0][1]).toEqual({ agent: "claude" });
  });

  it("passes the loaded creds (so the helper can read creds.autoupdate)", async () => {
    const creds = { token: "tok", orgId: "o", orgName: "acme", userName: "alice", workspaceId: "default" };
    loadCredsMock.mockReturnValue(creds);
    await runHook();
    expect(autoUpdateMock.mock.calls[0][0]).toEqual(creds);
  });

  it("passes null creds through (the helper short-circuits on it)", async () => {
    loadCredsMock.mockReturnValue(null);
    await runHook();
    expect(autoUpdateMock).toHaveBeenCalledTimes(1);
    expect(autoUpdateMock.mock.calls[0][0]).toBeNull();
  });

  // (autoUpdate-internal failure modes — network down, missing binary,
  // unknown subcommand — are exhaustively covered in autoupdate.test.ts.
  // The contract for the hook is "best-effort; never block session
  // start"; the helper itself enforces that by swallowing all errors.)
});

// ═══ Negative-pattern guard: legacy paths must NOT re-appear ════════════════

describe("session-start hook — legacy autoupdate paths are gone", () => {
  // Catches a regression where someone re-introduces the legacy paths.
  // After centralization, the hook MUST go through the autoUpdate helper
  // exclusively (which we mock above) — no direct execSync, no direct
  // fetch against GitHub raw `package.json`.
  //
  // We can't `vi.spyOn(childProcess, "execSync")` directly because of an
  // ESM namespace-immutability limit in vitest:
  //   https://vitest.dev/guide/browser/#limitations
  // The fetch-spy below provides the load-bearing negative check: the
  // legacy autoupdate flow ALWAYS started with a `fetch(githubraw)`, so
  // if no fetch fires, the legacy probe is gone, and by construction the
  // marketplace `claude plugin update` execSync that was gated on the
  // probe result can't fire either.

  it("does not call fetch from session-start (legacy GitHub raw probe)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    await runHook();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(autoUpdateMock).toHaveBeenCalled();
    fetchSpy.mockRestore();
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

// Additional branch coverage — context-shape edge cases that survived
// the autoupdate centralization (the hook still composes additionalContext
// from creds + version stamp, just without the legacy update plumbing).
describe("session-start hook — context shape edge cases", () => {
  it("includes version notice when getInstalledVersion returns a value", async () => {
    getInstalledVersionMock.mockReturnValue("0.7.4");
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("✅ Hivemind v0.7.4");
  });

  it("omits version notice when getInstalledVersion returns null", async () => {
    getInstalledVersionMock.mockReturnValue(null);
    const out = await runHook();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Hivemind v");
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
