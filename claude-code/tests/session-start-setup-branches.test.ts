import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Branch-coverage tests for src/hooks/session-start-setup.ts. These
 * mock version-check and plugin-cache so we can hit specific branches
 * the main source-level test can't reach against the real filesystem:
 *
 *  - userName fallback to "unknown" when node:os userInfo().username
 *    is nullish.
 *  - `if (current)` false branch — getInstalledVersion returns null.
 *  - `resolved ? snapshotPluginDir(...) : null` truthy branch — a real
 *    versioned install layout is detected, snapshot is taken, and
 *    restoreOrCleanup is called after the update completes.
 *  - Outer `try/catch (version check failed)` — getLatestVersion throws.
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const saveCredsMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const execSyncMock = vi.fn();
const userInfoMock = vi.fn();
const getInstalledVersionMock = vi.fn();
const getLatestVersionMock = vi.fn();
const isNewerMock = vi.fn();
const resolveVersionedPluginDirMock = vi.fn();
const snapshotPluginDirMock = vi.fn();
const restoreOrCleanupMock = vi.fn();

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
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: (...a: any[]) => execSyncMock(...a) };
});
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, userInfo: (...a: any[]) => userInfoMock(...a) };
});
vi.mock("../../src/utils/version-check.js", () => ({
  getInstalledVersion: (...a: any[]) => getInstalledVersionMock(...a),
  getLatestVersion: (...a: any[]) => getLatestVersionMock(...a),
  isNewer: (...a: any[]) => isNewerMock(...a),
}));
vi.mock("../../src/utils/plugin-cache.js", () => ({
  resolveVersionedPluginDir: (...a: any[]) => resolveVersionedPluginDirMock(...a),
  snapshotPluginDir: (...a: any[]) => snapshotPluginDirMock(...a),
  restoreOrCleanup: (...a: any[]) => restoreOrCleanupMock(...a),
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
  execSyncMock.mockReset();
  userInfoMock.mockReset().mockReturnValue({ username: "alice" });
  getInstalledVersionMock.mockReset().mockReturnValue("0.6.38");
  getLatestVersionMock.mockReset().mockResolvedValue("0.6.38");
  isNewerMock.mockReset().mockReturnValue(false);
  resolveVersionedPluginDirMock.mockReset().mockReturnValue(null);
  snapshotPluginDirMock.mockReset();
  restoreOrCleanupMock.mockReset().mockReturnValue("noop");
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

  it("skips autoupdate entirely when getInstalledVersion returns null", async () => {
    getInstalledVersionMock.mockReturnValue(null);
    await runHook();
    expect(getLatestVersionMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("takes the snapshot when resolveVersionedPluginDir returns a real install", async () => {
    getLatestVersionMock.mockResolvedValue("0.6.39");
    isNewerMock.mockReturnValue(true);
    resolveVersionedPluginDirMock.mockReturnValue({
      pluginDir: "/fake/plugin/dir",
      versionsRoot: "/fake/plugin",
      version: "0.6.38",
    });
    snapshotPluginDirMock.mockReturnValue({
      pluginDir: "/fake/plugin/dir",
      snapshot: "/fake/plugin/dir.keep-1234",
    });
    restoreOrCleanupMock.mockReturnValue("cleaned");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runHook();

    expect(snapshotPluginDirMock).toHaveBeenCalledWith("/fake/plugin/dir");
    expect(restoreOrCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      pluginDir: "/fake/plugin/dir",
    }));
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("autoupdate snapshot outcome: cleaned"),
    );
  });

  it("restores the snapshot on the failure path when execSync throws", async () => {
    getLatestVersionMock.mockResolvedValue("0.6.39");
    isNewerMock.mockReturnValue(true);
    resolveVersionedPluginDirMock.mockReturnValue({
      pluginDir: "/fake/plugin/dir",
      versionsRoot: "/fake/plugin",
      version: "0.6.38",
    });
    const handle = { pluginDir: "/fake/plugin/dir", snapshot: "/fake/snap" };
    snapshotPluginDirMock.mockReturnValue(handle);
    execSyncMock.mockImplementation(() => { throw new Error("network"); });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runHook();

    // Called once in the catch block (not the try path, since execSync threw)
    expect(restoreOrCleanupMock).toHaveBeenCalledWith(handle);
  });

  it("catches getLatestVersion throws and logs 'version check failed'", async () => {
    // getLatestVersion throwing is the only thing that can reach the
    // outer catch, since getInstalledVersion handles its own errors.
    getLatestVersionMock.mockRejectedValue(new Error("dns boom"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("version check failed: dns boom"),
    );
  });
});
