import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Direct source-level tests for src/hooks/codex/stop.ts. Covers the
 * whole hook: WIKI_WORKER guard, CAPTURE guard (computed at module
 * load — we resetModules per scenario), missing session_id, missing
 * config, transcript parsing (string / array / bad / missing), INSERT
 * failure path, lock held vs free, the spawn call, and the fatal catch.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnMock = vi.fn();
const wikiLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const debugLogMock = vi.fn();
const queryMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...args: any[]) => stdinMock(...args) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...args: any[]) => loadConfigMock(...args) }));
vi.mock("../../src/hooks/codex/spawn-wiki-worker.js", () => ({
  spawnCodexWikiWorker: (...args: any[]) => spawnMock(...args),
  wikiLog: (...args: any[]) => wikiLogMock(...args),
  bundleDirFromImportMeta: () => "/fake/codex/bundle",
}));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: (...args: any[]) => tryAcquireLockMock(...args),
  releaseLock: (...args: any[]) => releaseLockMock(...args),
}));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_tag: string, msg: string) => debugLogMock(msg),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class { query(sql: string) { return queryMock(sql); } },
}));

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  delete process.env.HIVEMIND_CAPTURE;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/codex/stop.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "org", workspaceId: "default",
  userName: "u", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codex-stop-test-"));
  stdinMock.mockReset().mockResolvedValue({
    session_id: "sid-1", cwd: "/proj/foo", hook_event_name: "Stop", model: "gpt-5",
    transcript_path: null,
  });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnMock.mockReset();
  wikiLogMock.mockReset();
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  releaseLockMock.mockReset();
  debugLogMock.mockReset();
  queryMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("codex stop hook — guard paths", () => {
  it("returns immediately when HIVEMIND_WIKI_WORKER=1", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when session_id is empty", async () => {
    stdinMock.mockResolvedValue({ session_id: "", cwd: "/x", hook_event_name: "Stop", model: "m" });
    await runHook();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
  });

  it("skips capture AND spawn when HIVEMIND_CAPTURE=false", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(queryMock).not.toHaveBeenCalled();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("codex stop hook — capture path + INSERT shape", () => {
  it("issues exactly one INSERT against the sessions table on the happy path", async () => {
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/^INSERT INTO "sessions"/);
    expect(sql).toContain("'Stop'");
    expect(sql).toContain("'codex'");
    expect(sql).toContain("sid-1");
    expect(sql).toContain("::jsonb");
    expect(debugLogMock).toHaveBeenCalledWith("stop event captured");
  });

  it("swallows an INSERT failure and still tries to spawn the wiki worker", async () => {
    queryMock.mockRejectedValue(new Error("network down"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("capture failed: network down");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("derives projectName=unknown when cwd is the empty string", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-x", cwd: "", hook_event_name: "Stop", model: "m", transcript_path: null,
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'unknown'");
  });
});

describe("codex stop hook — transcript parsing", () => {
  const writeTranscript = (lines: string[]): string => {
    const p = join(tmpDir, "transcript.jsonl");
    writeFileSync(p, lines.join("\n"));
    return p;
  };

  it("extracts the last assistant message when content is a plain string", async () => {
    const path = writeTranscript([
      JSON.stringify({ payload: { role: "user", content: "hi" } }),
      JSON.stringify({ payload: { role: "assistant", content: "hello there" } }),
    ]);
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/x", hook_event_name: "Stop", model: "m", transcript_path: path,
    });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("extracted assistant message from transcript"),
    );
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("hello there");
    expect(sql).toContain('"type":"assistant_message"');
  });

  it("extracts from content arrays, joining output_text / text blocks", async () => {
    const path = writeTranscript([
      JSON.stringify({
        payload: {
          role: "assistant",
          content: [
            { type: "output_text", text: "part A" },
            { type: "reasoning", text: "ignored" },
            { type: "text", text: "part B" },
          ],
        },
      }),
    ]);
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/x", hook_event_name: "Stop", model: "m", transcript_path: path,
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("part A");
    expect(sql).toContain("part B");
  });

  it("skips malformed JSONL lines and falls back to assistant_stop when no valid message", async () => {
    const path = writeTranscript([
      "{not json",
      JSON.stringify({ payload: { role: "user", content: "hey" } }),
    ]);
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/x", hook_event_name: "Stop", model: "m", transcript_path: path,
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"assistant_stop"');
  });

  it("handles a transcript_path that does not exist on disk (no log, no content)", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/x", hook_event_name: "Stop", model: "m",
      transcript_path: join(tmpDir, "missing.jsonl"),
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"assistant_stop"');
    expect(debugLogMock).not.toHaveBeenCalledWith(
      expect.stringContaining("extracted assistant message"),
    );
  });

  it("treats content as empty when it is neither string nor array (defensive branch)", async () => {
    const path = writeTranscript([
      JSON.stringify({ payload: { role: "assistant", content: { weird: true } } }),
    ]);
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/x", hook_event_name: "Stop", model: "m", transcript_path: path,
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"assistant_stop"');
  });
});

describe("codex stop hook — wiki spawn + lock coordination", () => {
  it("skips the wiki spawn with a log line when tryAcquireLock returns false", async () => {
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(wikiLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic worker already running for sid-1, skipping"),
    );
  });

  it("spawns the codex wiki worker on the happy path with the right arguments", async () => {
    await runHook();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const arg = spawnMock.mock.calls[0][0];
    expect(arg.sessionId).toBe("sid-1");
    expect(arg.cwd).toBe("/proj/foo");
    expect(arg.reason).toBe("Stop");
    expect(arg.config).toBe(validConfig);
  });
});

describe("codex stop hook — fatal catch", () => {
  it("catches a thrown readStdin error and exits 0 without crashing", async () => {
    stdinMock.mockRejectedValue(new Error("bad stdin"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: bad stdin");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("releases the lock if spawnCodexWikiWorker throws (no lock leak)", async () => {
    spawnMock.mockImplementation(() => { throw new Error("codex spawn exploded"); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(releaseLockMock).toHaveBeenCalledWith("sid-1");
    expect(debugLogMock).toHaveBeenCalledWith("fatal: codex spawn exploded");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("swallows release errors when spawn also throws (no double-fault)", async () => {
    spawnMock.mockImplementation(() => { throw new Error("codex spawn exploded"); });
    releaseLockMock.mockImplementation(() => { throw new Error("release broken"); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: codex spawn exploded");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
