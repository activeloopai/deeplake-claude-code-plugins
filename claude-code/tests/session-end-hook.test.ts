import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Direct source-level tests for src/hooks/session-end.ts. The hook's
 * `main()` runs at module import time, so each test resets the module
 * registry, wires mocks, then dynamically imports the module and waits
 * for the main promise chain to settle.
 *
 * Coverage target: every branch of the hook — the WIKI_WORKER / CAPTURE
 * early-exits, empty session_id, missing config, lock held, happy path,
 * and the outer catch for thrown errors.
 *
 * CLAUDE.md rule #2: mock only at the boundary. readStdin, loadConfig,
 * spawnWikiWorker, wikiLog, and tryAcquireLock are the seams. The rest
 * of the hook body runs for real.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnMock = vi.fn();
const wikiLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const debugLogMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: stdinMock }));
vi.mock("../../src/config.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../../src/hooks/spawn-wiki-worker.js", () => ({
  spawnWikiWorker: spawnMock,
  wikiLog: wikiLogMock,
  bundleDirFromImportMeta: () => "/fake/bundle",
}));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: tryAcquireLockMock,
}));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_tag: string, msg: string) => debugLogMock(msg),
}));

async function runHook(): Promise<void> {
  vi.resetModules();
  await import("../../src/hooks/session-end.js");
  // main() is async and fires on import; give the microtask queue a
  // chance to drain before we assert on the mocks.
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "o", workspaceId: "default",
  userName: "u", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

beforeEach(() => {
  delete process.env.HIVEMIND_WIKI_WORKER;
  delete process.env.HIVEMIND_CAPTURE;
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", cwd: "/proj" });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnMock.mockReset();
  wikiLogMock.mockReset();
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  debugLogMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("session-end hook", () => {
  it("returns immediately when HIVEMIND_WIKI_WORKER=1 (nested worker invocation)", async () => {
    process.env.HIVEMIND_WIKI_WORKER = "1";
    await runHook();
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
  });

  it("returns immediately when HIVEMIND_CAPTURE=false (opt-out)", async () => {
    process.env.HIVEMIND_CAPTURE = "false";
    await runHook();
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when session_id is missing", async () => {
    stdinMock.mockResolvedValue({ session_id: "", cwd: "/proj" });
    await runHook();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when loadConfig returns null (no credentials)", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
  });

  it("skips spawn with a wiki log line when the periodic worker holds the lock", async () => {
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic worker already running for sid-1, skipping"),
    );
  });

  it("spawns the wiki worker on the happy path and logs 'triggering summary'", async () => {
    await runHook();
    expect(tryAcquireLockMock).toHaveBeenCalledWith("sid-1");
    expect(wikiLogMock).toHaveBeenCalledWith(
      expect.stringContaining("triggering summary for sid-1"),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const callArg = spawnMock.mock.calls[0][0];
    expect(callArg.sessionId).toBe("sid-1");
    expect(callArg.cwd).toBe("/proj");
    expect(callArg.reason).toBe("SessionEnd");
    expect(callArg.config).toBe(validConfig);
  });

  it("falls back to empty cwd when stdin omits the field", async () => {
    stdinMock.mockResolvedValue({ session_id: "sid-2" });
    await runHook();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sid-2", cwd: "" }),
    );
  });

  it("catches and logs a fatal error from readStdin without crashing the process", async () => {
    const boom = new Error("stdin boom");
    stdinMock.mockRejectedValue(boom);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    // Let the catch in `main().catch(...)` run.
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: stdin boom");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
