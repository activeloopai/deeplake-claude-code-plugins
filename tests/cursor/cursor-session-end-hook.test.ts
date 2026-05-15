import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinMock = vi.fn();
const debugLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnCursorWikiWorkerMock = vi.fn();
const wikiLogMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: (...a: unknown[]) => tryAcquireLockMock(...a),
}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/hooks/cursor/spawn-wiki-worker.js", () => ({
  spawnCursorWikiWorker: (...a: unknown[]) => spawnCursorWikiWorkerMock(...a),
  wikiLog: (...a: unknown[]) => wikiLogMock(...a),
  bundleDirFromImportMeta: () => "/tmp/bundle",
}));

const validConfig = {
  token: "t", apiUrl: "http://example", orgId: "o", orgName: "acme",
  workspaceId: "ws", userName: "alice",
  tableName: "memory", sessionsTableName: "sessions",
};

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/cursor/session-end.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({});
  debugLogMock.mockReset();
  // Default to "lock acquired + config loaded + spawn ok" so the happy path runs
  // unless a test overrides one of these.
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnCursorWikiWorkerMock.mockReset();
  wikiLogMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("cursor session-end hook (stub)", () => {
  it("HIVEMIND_WIKI_WORKER=1 → no stdin read", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("logs session id, reason, and final_status when present", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "conv-7",
      reason: "user-quit",
      final_status: "completed",
    });
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=conv-7");
    expect(text).toContain("reason=user-quit");
    expect(text).toContain("status=completed");
  });

  it("falls back to session_id when conversation_id is missing", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-1" });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("session=ses-1"));
  });

  it("falls back to '?' for missing session/reason/status fields", async () => {
    stdinMock.mockResolvedValue({});
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=?");
    expect(text).toContain("reason=?");
    expect(text).toContain("status=?");
  });

  it("readStdin throwing → caught, logs 'fatal: ...' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin pipe died"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin pipe died"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("missing session id → returns without spawning the worker", async () => {
    stdinMock.mockResolvedValue({});  // no conversation_id, no session_id
    await runHook();
    expect(spawnCursorWikiWorkerMock).not.toHaveBeenCalled();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
  });

  it("lock already held by periodic worker → log and skip the final spawn", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "conv-9" });
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(tryAcquireLockMock).toHaveBeenCalledWith("conv-9");
    expect(spawnCursorWikiWorkerMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("periodic worker already running"));
  });

  it("loadConfig returns null → log and skip without crashing", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "conv-10" });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(spawnCursorWikiWorkerMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("no config"));
  });

  it("happy path: lock acquired + config present → spawnCursorWikiWorker called with reason=SessionEnd", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "conv-11" });
    await runHook();
    expect(spawnCursorWikiWorkerMock).toHaveBeenCalledTimes(1);
    const arg = spawnCursorWikiWorkerMock.mock.calls[0][0];
    expect(arg.sessionId).toBe("conv-11");
    expect(arg.reason).toBe("SessionEnd");
    expect(arg.config).toBe(validConfig);
  });

  it("spawnCursorWikiWorker throwing → caught, wiki-logged 'spawn failed', does not crash", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "conv-12" });
    spawnCursorWikiWorkerMock.mockImplementation(() => { throw new Error("ENOENT cursor-agent"); });
    await runHook();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("ENOENT cursor-agent"));
  });
});
