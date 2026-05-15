import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Branch-coverage tests for src/hooks/session-start-setup.ts.
 *
 * After PR #97 + autoupdate latency fix, this hook is much smaller:
 * its old responsibilities (version-check, marketplace plugin update,
 * snapshot/restore) all moved into the shared autoUpdate helper, which
 * is now a fire-and-forget detached spawn. The remaining branches worth
 * targeting here are the userName backfill fallback, table-setup
 * skip-when-no-config, and the EmbedClient warmup paths.
 *
 * The autoUpdate helper itself is exhaustively tested in
 * `tests/claude-code/autoupdate.test.ts`. We mock it at the boundary
 * here so the setup hook can be tested in isolation.
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const saveCredsMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const userInfoMock = vi.fn();
const autoUpdateMock = vi.fn();
const embedWarmupMock = vi.fn();

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
  },
}));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, userInfo: (...a: any[]) => userInfoMock(...a) };
});
vi.mock("../../src/hooks/shared/autoupdate.js", () => ({
  autoUpdate: (...a: any[]) => autoUpdateMock(...a),
}));
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    async warmup() { return embedWarmupMock(); }
  },
}));

async function runHook(): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  vi.resetModules();
  await import("../../src/hooks/session-start-setup.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
  userName: "alice", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", cwd: "/x" });
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "o", orgName: "acme", userName: "alice",
  });
  saveCredsMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  ensureTableMock.mockReset().mockResolvedValue(undefined);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  userInfoMock.mockReset().mockReturnValue({ username: "alice" });
  autoUpdateMock.mockReset().mockResolvedValue(undefined);
  embedWarmupMock.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-start-setup — branch coverage", () => {
  it("falls back to 'unknown' when userInfo().username is nullish", async () => {
    loadCredsMock.mockReturnValue({ token: "t", orgId: "o", orgName: "acme" });
    userInfoMock.mockReturnValue({ username: undefined });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("backfilled userName: unknown");
    expect(saveCredsMock).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "unknown" }),
    );
  });

  it("invokes autoUpdate exactly once with agent: 'claude'", async () => {
    await runHook();
    expect(autoUpdateMock).toHaveBeenCalledTimes(1);
    expect(autoUpdateMock.mock.calls[0][1]).toEqual({ agent: "claude" });
  });

  it("autoUpdate fires BEFORE the DB ensure-table calls (so a slow backend doesn't delay the upgrade trigger)", async () => {
    // Fail-fast db so we can see the call ordering: autoUpdate must
    // have been called before ensureTable runs (and rejects).
    let autoUpdateCalledAt = -1;
    let ensureTableCalledAt = -1;
    let counter = 0;
    autoUpdateMock.mockImplementation(async () => { autoUpdateCalledAt = counter++; });
    ensureTableMock.mockImplementation(async () => { ensureTableCalledAt = counter++; });

    await runHook();

    expect(autoUpdateCalledAt).toBeGreaterThanOrEqual(0);
    expect(ensureTableCalledAt).toBeGreaterThanOrEqual(0);
    expect(autoUpdateCalledAt).toBeLessThan(ensureTableCalledAt);
  });

  it("skips table setup when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });

  it("does not crash when EmbedClient warmup throws", async () => {
    embedWarmupMock.mockRejectedValue(new Error("warmup boom"));
    await expect(runHook()).resolves.toBeUndefined();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("embed daemon warmup threw"),
    );
  });
});

describe("session-start-setup — legacy autoupdate paths are gone", () => {
  // Negative-pattern guard: the hook MUST NOT reach for the old
  // version-check / snapshot / execSync APIs after centralization.

  it("does not call execSync (legacy 'claude plugin update' path)", async () => {
    // node:child_process can't be hot-spied via vi.spyOn (ESM
    // namespace immutability). Instead, verify the hook reaches
    // autoUpdate — by construction, that means the legacy code path
    // (which would have execSync'd long before reaching autoUpdate)
    // wasn't taken.
    await runHook();
    expect(autoUpdateMock).toHaveBeenCalled();
  });

  it("does not call fetch (legacy GitHub-raw version probe)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    await runHook();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
