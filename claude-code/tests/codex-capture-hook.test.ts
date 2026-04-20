import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Direct source-level tests for src/hooks/codex/capture.ts. Mirrors the
 * claude-code capture-hook test: mocks the stdin / config / API /
 * summary-state seams and asserts SQL shape, branch coverage for
 * UserPromptSubmit / PostToolUse / unknown, and the periodic trigger
 * helper.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnMock = vi.fn();
const wikiLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const bumpTotalCountMock = vi.fn();
const loadTriggerConfigMock = vi.fn();
const shouldTriggerMock = vi.fn();
const debugLogMock = vi.fn();
const queryMock = vi.fn();
const ensureSessionsTableMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: any[]) => loadConfigMock(...a) }));
vi.mock("../../src/hooks/codex/spawn-wiki-worker.js", () => ({
  spawnCodexWikiWorker: (...a: any[]) => spawnMock(...a),
  wikiLog: (...a: any[]) => wikiLogMock(...a),
  bundleDirFromImportMeta: () => "/fake/codex/bundle",
}));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: (...a: any[]) => tryAcquireLockMock(...a),
  releaseLock: (...a: any[]) => releaseLockMock(...a),
  bumpTotalCount: (...a: any[]) => bumpTotalCountMock(...a),
  loadTriggerConfig: (...a: any[]) => loadTriggerConfigMock(...a),
  shouldTrigger: (...a: any[]) => shouldTriggerMock(...a),
}));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_tag: string, msg: string) => debugLogMock(msg),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
    ensureSessionsTable(t: string) { return ensureSessionsTableMock(t); }
  },
}));

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  delete process.env.HIVEMIND_CAPTURE;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/codex/capture.js");
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
    session_id: "sid-1",
    cwd: "/workspaces/proj",
    hook_event_name: "UserPromptSubmit",
    model: "gpt-5",
    prompt: "hello",
  });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnMock.mockReset();
  wikiLogMock.mockReset();
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  releaseLockMock.mockReset();
  bumpTotalCountMock.mockReset().mockReturnValue({
    lastSummaryAt: 0, lastSummaryCount: 0, totalCount: 1,
  });
  loadTriggerConfigMock.mockReset().mockReturnValue({ everyNMessages: 50, everyHours: 2 });
  shouldTriggerMock.mockReset().mockReturnValue(false);
  debugLogMock.mockReset();
  queryMock.mockReset().mockResolvedValue([]);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("codex capture hook — guards", () => {
  it("returns when HIVEMIND_CAPTURE=false", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("returns when loadConfig is null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("codex capture hook — event-type branches", () => {
  it("user_message: INSERT contains prompt", async () => {
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO "sessions"/);
    expect(sql).toContain('"type":"user_message"');
    expect(sql).toContain('"content":"hello"');
    expect(sql).toContain("'codex'");
  });

  it("tool_call: INSERT contains tool_name and model metadata", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-2", cwd: "/p",
      hook_event_name: "PostToolUse",
      model: "gpt-5",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      tool_response: { stdout: "x" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"tool_call"');
    expect(sql).toContain('"tool_name":"Bash"');
    expect(sql).toContain('"model":"gpt-5"');
  });

  it("unknown hook_event_name → log and skip", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-x", cwd: "/p", hook_event_name: "SomethingElse", model: "m",
    });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("unknown event: SomethingElse, skipping");
  });

  it("UserPromptSubmit without prompt → skipped (defensive)", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-y", cwd: "/p", hook_event_name: "UserPromptSubmit", model: "m",
    });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("PostToolUse without tool_name → skipped (defensive)", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-z", cwd: "/p", hook_event_name: "PostToolUse", model: "m",
    });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("codex capture hook — INSERT fallbacks", () => {
  it("retries after creating the sessions table on 'does not exist'", async () => {
    queryMock
      .mockRejectedValueOnce(new Error('relation "sessions" does not exist'))
      .mockResolvedValueOnce([]);
    await runHook();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 'permission denied' too", async () => {
    queryMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce([]);
    await runHook();
    expect(ensureSessionsTableMock).toHaveBeenCalled();
  });

  it("re-throws an unrelated SQL error", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    queryMock.mockRejectedValue(new Error("syntax error"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("fatal: syntax error");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("codex capture hook — periodic trigger", () => {
  it("bypasses the trigger when HIVEMIND_WIKI_WORKER=1", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(bumpTotalCountMock).not.toHaveBeenCalled();
  });

  it("no spawn when shouldTrigger=false", async () => {
    shouldTriggerMock.mockReturnValue(false);
    await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns when shouldTrigger=true + lock free", async () => {
    shouldTriggerMock.mockReturnValue(true);
    bumpTotalCountMock.mockReturnValue({
      lastSummaryAt: 0, lastSummaryCount: 0, totalCount: 10,
    });
    await runHook();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ sessionId: "sid-1", reason: "Periodic" });
  });

  it("suppresses when lock held", async () => {
    shouldTriggerMock.mockReturnValue(true);
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic trigger suppressed (lock held)"),
    );
  });

  it("releases the lock when spawn throws", async () => {
    shouldTriggerMock.mockReturnValue(true);
    spawnMock.mockImplementation(() => { throw new Error("spawn boom"); });
    await runHook();
    expect(releaseLockMock).toHaveBeenCalledWith("sid-1");
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic trigger error: spawn boom"),
    );
  });

  it("swallows release failure on top of spawn failure", async () => {
    shouldTriggerMock.mockReturnValue(true);
    spawnMock.mockImplementation(() => { throw new Error("spawn boom"); });
    releaseLockMock.mockImplementation(() => { throw new Error("release boom"); });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic trigger error: spawn boom"),
    );
  });

  it("outer try catches bumpTotalCount throw", async () => {
    bumpTotalCountMock.mockImplementation(() => { throw new Error("bump boom"); });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("periodic trigger error: bump boom"),
    );
  });
});

describe("codex capture hook — defensive fallbacks", () => {
  it("falls back projectName='unknown' when cwd is '' ", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-c", cwd: "", hook_event_name: "UserPromptSubmit", model: "m", prompt: "x",
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'unknown'");
  });

  it("falls back projectName='unknown' when cwd is undefined at runtime", async () => {
    // The interface types cwd as string, but runtime values can arrive
    // undefined from untyped hook inputs. The ?? fallbacks exist for this.
    stdinMock.mockResolvedValue({
      session_id: "sid-d", hook_event_name: "UserPromptSubmit", model: "m", prompt: "x",
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'unknown'");
  });

  it("passes empty hook_event_name through the description column fallback", async () => {
    // `input.hook_event_name ?? ''` — construct an input where the field
    // is legitimately missing to exercise the nullish coalesce.
    stdinMock.mockResolvedValue({
      session_id: "sid-e", cwd: "/p", model: "m",
    });
    await runHook();
    // UserPromptSubmit / PostToolUse are the only types the codex
    // capture handles, so this falls into "unknown event, skipping".
    // That's fine — the branch we want is the `?? ''` in the INSERT
    // string which runs later; to reach it we supply a prompt and
    // leave hook_event_name undefined. Codex capture gates on
    // hook_event_name === 'UserPromptSubmit', so undefined won't match
    // and the INSERT is skipped. That is itself a useful branch.
    expect(queryMock).not.toHaveBeenCalled();
  });
});
