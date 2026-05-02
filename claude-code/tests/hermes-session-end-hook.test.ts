import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinMock = vi.fn();
const debugLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnHermesWikiWorkerMock = vi.fn();
const wikiLogMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: (...a: unknown[]) => tryAcquireLockMock(...a),
}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/hooks/hermes/spawn-wiki-worker.js", () => ({
  spawnHermesWikiWorker: (...a: unknown[]) => spawnHermesWikiWorkerMock(...a),
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
  await import("../../src/hooks/hermes/session-end.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({});
  debugLogMock.mockReset();
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnHermesWikiWorkerMock.mockReset();
  wikiLogMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("hermes session-end hook (stub)", () => {
  it("HIVEMIND_WIKI_WORKER=1 → no stdin read", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("logs session_id + cwd when present", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-9", cwd: "/proj" });
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=ses-9");
    expect(text).toContain("cwd=/proj");
  });

  it("falls back to '?' for missing fields", async () => {
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=?");
    expect(text).toContain("cwd=?");
  });

  it("readStdin throwing → caught, logs 'fatal: ...' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin pipe died"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin pipe died"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("missing session id → returns without spawning the worker", async () => {
    stdinMock.mockResolvedValue({});  // no session_id at all
    await runHook();
    expect(spawnHermesWikiWorkerMock).not.toHaveBeenCalled();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
  });

  it("lock already held by periodic worker → log and skip the final spawn", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-9" });
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(tryAcquireLockMock).toHaveBeenCalledWith("ses-9");
    expect(spawnHermesWikiWorkerMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("periodic worker already running"));
  });

  it("loadConfig returns null → log and skip without crashing", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-10" });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(spawnHermesWikiWorkerMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("no config"));
  });

  it("happy path: lock acquired + config present → spawnHermesWikiWorker called with reason=SessionEnd", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-11", cwd: "/proj" });
    await runHook();
    expect(spawnHermesWikiWorkerMock).toHaveBeenCalledTimes(1);
    const arg = spawnHermesWikiWorkerMock.mock.calls[0][0];
    expect(arg.sessionId).toBe("ses-11");
    expect(arg.reason).toBe("SessionEnd");
    expect(arg.config).toBe(validConfig);
    expect(arg.cwd).toBe("/proj");
  });

  it("spawnHermesWikiWorker throwing → caught, wiki-logged 'spawn failed', does not crash", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-12" });
    spawnHermesWikiWorkerMock.mockImplementation(() => { throw new Error("ENOENT hermes"); });
    await runHook();
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));
    expect(wikiLogMock).toHaveBeenCalledWith(expect.stringContaining("ENOENT hermes"));
  });
});
