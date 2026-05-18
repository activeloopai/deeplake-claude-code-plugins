import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/skillify/spawn-mine-local-worker.ts.
 *
 * The module bakes in `~/.claude/...` paths at module load time via
 * `homedir() + join(...)`, and its single exported function calls
 * existsSync/readdirSync/statSync/openSync/unlinkSync/mkdirSync/spawn —
 * a lot of side effects, but a small surface and well-defined branches.
 * We mock node:fs and node:child_process at the module boundary, then
 * dynamically import per test so each describe can stage a different
 * filesystem state and assert which AutoMineGuardReport reason fires.
 */

const existsSyncMock = vi.fn();
const statSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const openSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...a: any[]) => existsSyncMock(...a),
    statSync: (...a: any[]) => statSyncMock(...a),
    readdirSync: (...a: any[]) => readdirSyncMock(...a),
    openSync: (...a: any[]) => openSyncMock(...a),
    closeSync: (...a: any[]) => closeSyncMock(...a),
    unlinkSync: (...a: any[]) => unlinkSyncMock(...a),
    mkdirSync: (...a: any[]) => mkdirSyncMock(...a),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...a: any[]) => execFileSyncMock(...a),
    spawn: (...a: any[]) => spawnMock(...a),
  };
});

/** Each test re-imports the module so its const HOME / HIVEMIND_DIR etc. capture
 *  the current homedir at module-evaluation time, and so mocks are fresh. */
async function loadModule() {
  vi.resetModules();
  return await import("../../src/skillify/spawn-mine-local-worker.js");
}

/**
 * `existsSync` is called multiple times with different paths inside
 * `maybeAutoMineLocal`. This helper builds a per-test path→exists predicate
 * so each test can stage exactly the files it needs.
 */
function stageExists(map: Record<string, boolean>): void {
  existsSyncMock.mockImplementation((p: string) => {
    for (const [substr, exists] of Object.entries(map)) {
      if (p.includes(substr)) return exists;
    }
    return false;
  });
}

function makeFakeChild() {
  return { unref: vi.fn() };
}

beforeEach(() => {
  existsSyncMock.mockReset();
  statSyncMock.mockReset();
  readdirSyncMock.mockReset();
  openSyncMock.mockReset();
  closeSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  execFileSyncMock.mockReset();
  spawnMock.mockReset().mockImplementation(() => makeFakeChild());
});

afterEach(() => { vi.restoreAllMocks(); });

describe("maybeAutoMineLocal — guard branches", () => {
  it("skips with reason=manifest-exists when the manifest is already present", async () => {
    stageExists({ "local-mined.json": true });
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(r).toEqual({ triggered: false, reason: "manifest-exists" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips with reason=lock-exists when a FRESH lock is present (mtime < 15min ago)", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": true,
      "/projects": true,
    });
    statSyncMock.mockReturnValue({ mtimeMs: Date.now() - 5 * 60 * 1000 } as any);
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(r).toEqual({ triggered: false, reason: "lock-exists" });
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it("overrides a STALE lock (mtime > 15min ago) and continues", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": true,
      "/projects": true,
    });
    statSyncMock.mockReturnValue({ mtimeMs: Date.now() - 16 * 60 * 1000 } as any);
    readdirSyncMock.mockReturnValueOnce(["sub1"]).mockReturnValueOnce(["a.jsonl"]);
    execFileSyncMock.mockReturnValue("/usr/local/bin/hivemind\n");
    openSyncMock.mockReturnValue(42);
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(unlinkSyncMock).toHaveBeenCalled();
    expect(r.triggered).toBe(true);
  });

  it("treats stale-lock unlink failure as lock-exists (cannot recover)", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": true,
      "/projects": true,
    });
    statSyncMock.mockReturnValue({ mtimeMs: Date.now() - 16 * 60 * 1000 } as any);
    unlinkSyncMock.mockImplementation(() => { throw new Error("EBUSY"); });
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(r).toEqual({ triggered: false, reason: "lock-exists" });
  });

  it("treats statSync failure on the lock as not-stale (defensive default)", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": true,
      "/projects": true,
    });
    statSyncMock.mockImplementation(() => { throw new Error("ENOENT"); });
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(r).toEqual({ triggered: false, reason: "lock-exists" });
  });

  it("skips with reason=no-claude-sessions when ~/.claude/projects does not exist", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": false,
    });
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "no-claude-sessions" });
  });

  it("skips with reason=no-claude-sessions when projects/ readdir throws", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
    });
    readdirSyncMock.mockImplementation(() => { throw new Error("EACCES"); });
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "no-claude-sessions" });
  });

  it("skips with reason=no-claude-sessions when every project dir has no .jsonl", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
    });
    readdirSyncMock
      .mockReturnValueOnce(["sub1", "sub2"])
      .mockReturnValueOnce(["README.md"])
      .mockReturnValueOnce(["notes.txt"]);
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "no-claude-sessions" });
  });

  it("tolerates a subdir whose readdir throws and keeps scanning the rest", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
    });
    let call = 0;
    readdirSyncMock.mockImplementation(() => {
      call++;
      if (call === 1) return ["broken", "good"];
      if (call === 2) throw new Error("EACCES on broken");
      return ["session.jsonl"];
    });
    execFileSyncMock.mockReturnValue("/usr/local/bin/hivemind\n");
    openSyncMock.mockReturnValue(42);
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal().triggered).toBe(true);
  });

  it("skips with reason=no-hivemind-bin when both bundled cli.js and PATH lookup fail", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": false, // bundled CLI absent
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    execFileSyncMock.mockImplementation(() => { throw new Error("which: not found"); });
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "no-hivemind-bin" });
  });

  it("skips with reason=no-hivemind-bin when `which hivemind` returns whitespace-only output", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": false,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    execFileSyncMock.mockReturnValue("   \n");
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "no-hivemind-bin" });
  });

  it("prefers the bundled cli.js launcher when it exists (no `which` fallback)", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": true,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    openSyncMock.mockReturnValue(42);
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal().triggered).toBe(true);
    // Spawn must use process.execPath (node) + cli.js path — NOT `which`.
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toContain("bundle/cli.js");
    expect(args.slice(1)).toEqual(["skillify", "mine-local"]);
  });

  it("falls back to the bin launcher when bundled cli.js is missing", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": false,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin/hivemind\n");
    openSyncMock.mockReturnValue(42);
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal().triggered).toBe(true);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("/opt/homebrew/bin/hivemind");
    expect(args).toEqual(["skillify", "mine-local"]);
  });

  it("skips with reason=lock-acquire-failed when openSync(wx) throws (race lost)", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": true,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    openSyncMock.mockImplementation((_path: string, flag: string) => {
      if (flag === "wx") throw new Error("EEXIST");
      return 42;
    });
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "lock-acquire-failed" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips with reason=spawn-failed and releases the lock when spawn throws", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": true,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    openSyncMock.mockReturnValue(42);
    spawnMock.mockImplementation(() => { throw new Error("EAGAIN"); });
    const { maybeAutoMineLocal } = await loadModule();
    expect(maybeAutoMineLocal()).toEqual({ triggered: false, reason: "spawn-failed" });
    // Lock must be released so the next SessionStart can retry.
    expect(unlinkSyncMock).toHaveBeenCalled();
  });

  it("happy path: spawns a detached child and returns triggered:true", async () => {
    stageExists({
      "local-mined.json": false,
      "local-mined.lock": false,
      "/projects": true,
      "bundle/cli.js": true,
    });
    readdirSyncMock.mockReturnValueOnce(["sub"]).mockReturnValueOnce(["a.jsonl"]);
    openSyncMock.mockReturnValue(42);
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);
    const { maybeAutoMineLocal } = await loadModule();
    const r = maybeAutoMineLocal();
    expect(r).toEqual({ triggered: true });
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 42, 42]);
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });
});
