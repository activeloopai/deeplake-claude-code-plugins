/**
 * Orchestrator coverage for src/commands/mine-local.ts — runMineLocal,
 * runGateViaStdin, parallelMap, arg parsers, renderPairsBlock,
 * buildSessionPrompt, loadExistingSummaries, gateAgentFor, and the
 * other side-effectful helpers. The pure helpers (parseMultiVerdict,
 * summaryTokens, jaccard, findOverlap) are tested in mine-local-helpers.test.ts.
 *
 * Strategy: mock every external module at the network/FS boundary,
 * exercise each branch of runMineLocal under controlled fixtures, and
 * assert on the calls made (writeNewSkill, fanOutSymlinks, manifest writes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type SpawnArgs = { bin: string; args: string[] };
let spawnCalls: SpawnArgs[] = [];
let spawnBehavior: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  emitError?: Error;
  stdinError?: Error;
  hang?: boolean;
} = {};

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args });
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (spawnBehavior.emitError) {
        child.emit("error", spawnBehavior.emitError);
        return;
      }
      if (spawnBehavior.stdinError) {
        child.stdin.emit("error", spawnBehavior.stdinError);
        return;
      }
      if (spawnBehavior.stdout) child.stdout.write(spawnBehavior.stdout);
      if (spawnBehavior.stderr) child.stderr.write(spawnBehavior.stderr);
      child.stdout.end();
      child.stderr.end();
      if (!spawnBehavior.hang) {
        queueMicrotask(() => child.emit("close", spawnBehavior.exitCode ?? 0));
      }
    });
    return child;
  }),
}));

// Mocks for the heavy imports inside mine-local.ts orchestrator.
const detectInstalledAgents = vi.fn();
const detectHostAgent = vi.fn();
const listLocalSessions = vi.fn();
const pickSessions = vi.fn();
const nativeJsonlToRows = vi.fn();

vi.mock("../../src/skillify/local-source.js", () => ({
  detectInstalledAgents: (...args: any[]) => detectInstalledAgents(...args),
  detectHostAgent: (...args: any[]) => detectHostAgent(...args),
  listLocalSessions: (...args: any[]) => listLocalSessions(...args),
  pickSessions: (...args: any[]) => pickSessions(...args),
  nativeJsonlToRows: (...args: any[]) => nativeJsonlToRows(...args),
}));

const extractPairs = vi.fn();
vi.mock("../../src/skillify/extractors/index.js", () => ({
  extractPairs: (...args: any[]) => extractPairs(...args),
}));

const findAgentBin = vi.fn();
vi.mock("../../src/skillify/gate-runner.js", () => ({
  findAgentBin: (...args: any[]) => findAgentBin(...args),
}));

const resolveSkillsRoot = vi.fn();
const writeNewSkill = vi.fn();
const listSkills = vi.fn();
const parseFrontmatter = vi.fn();
vi.mock("../../src/skillify/skill-writer.js", () => ({
  resolveSkillsRoot: (...args: any[]) => resolveSkillsRoot(...args),
  writeNewSkill: (...args: any[]) => writeNewSkill(...args),
  listSkills: (...args: any[]) => listSkills(...args),
  parseFrontmatter: (...args: any[]) => parseFrontmatter(...args),
}));

const detectAgentSkillsRoots = vi.fn();
vi.mock("../../src/skillify/agent-roots.js", () => ({
  detectAgentSkillsRoots: (...args: any[]) => detectAgentSkillsRoots(...args),
}));

const fanOutSymlinks = vi.fn();
vi.mock("../../src/skillify/pull.js", () => ({
  fanOutSymlinks: (...args: any[]) => fanOutSymlinks(...args),
}));

const readLocalManifest = vi.fn();
const writeLocalManifest = vi.fn();
vi.mock("../../src/skillify/local-manifest.js", async (orig) => {
  const actual = await orig<typeof import("../../src/skillify/local-manifest.js")>();
  return {
    ...actual,
    readLocalManifest: (...args: any[]) => readLocalManifest(...args),
    writeLocalManifest: (...args: any[]) => writeLocalManifest(...args),
  };
});

function makeSession(id: string, mtime: number, agent = "claude_code") {
  return {
    agent,
    path: `/sessions/${id}.jsonl`,
    mtime,
    inCwd: true,
    sessionId: id,
  };
}

async function importOrch() {
  // Re-import to pick up reset mocks where needed.
  vi.resetModules();
  return await import("../../src/commands/mine-local.js");
}

describe("runMineLocal: orchestrator branches", () => {
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mine-local-orch-"));
    spawnCalls = [];
    spawnBehavior = { exitCode: 0 };
    vi.clearAllMocks();

    detectInstalledAgents.mockReturnValue([
      { agent: "claude_code", sessionRoot: "/fake", encodeCwd: () => "x" },
    ]);
    detectHostAgent.mockReturnValue("claude_code");
    listLocalSessions.mockReturnValue([]);
    pickSessions.mockImplementation((sessions, _o) => sessions);
    nativeJsonlToRows.mockReturnValue([]);
    extractPairs.mockReturnValue([]);
    findAgentBin.mockReturnValue(process.execPath);
    resolveSkillsRoot.mockReturnValue(join(tmpHome, "skills"));
    listSkills.mockReturnValue([]);
    parseFrontmatter.mockReturnValue({ fm: { description: "" }, body: "" });
    detectAgentSkillsRoots.mockReturnValue([]);
    fanOutSymlinks.mockReturnValue([]);
    readLocalManifest.mockReturnValue(null);
    writeLocalManifest.mockImplementation(() => {});
    writeNewSkill.mockImplementation((opts: any) => ({
      path: join(opts.skillsRoot, opts.name, "SKILL.md"),
      createdAt: "2026-05-15T00:00:00Z",
    }));

    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
    // Clean up any process.on('exit') listeners runMineLocal installed.
    process.removeAllListeners("exit");
  });

  it("exits 1 when manifest exists and --force is not passed", async () => {
    readLocalManifest.mockReturnValueOnce({ created_at: "old", entries: [] });
    const mod = await importOrch();
    await expect(mod.runMineLocal([])).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("already been mined"));
  });

  it("continues past manifest check when --force is passed", async () => {
    readLocalManifest.mockReturnValueOnce({ created_at: "old", entries: [] });
    detectInstalledAgents.mockReturnValueOnce([]);
    const mod = await importOrch();
    await expect(mod.runMineLocal(["--force"])).rejects.toThrow("__exit_1__");
    // We got past manifest check and hit the "no agents" exit
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No agent session directories"));
  });

  it("exits 1 when no agents are installed", async () => {
    detectInstalledAgents.mockReturnValueOnce([]);
    const mod = await importOrch();
    await expect(mod.runMineLocal([])).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No agent session directories"));
  });

  it("exits 1 when all sessions are in-flight (mtime within last 60s)", async () => {
    const now = Date.now();
    listLocalSessions.mockReturnValueOnce([makeSession("a", now), makeSession("b", now)]);
    const mod = await importOrch();
    await expect(mod.runMineLocal([])).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No mineable session files"));
  });

  it("dry-run prints the plan and returns without spawning the gate", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("a", old)]);
    const mod = await importOrch();
    await mod.runMineLocal(["--dry-run"]);
    expect(spawnCalls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Dry-run"));
  });

  it("happy path: 1 session, 1 KEEP candidate → writes skill + manifest", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("sess-aaaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "do thing", answer: "did thing" }]);
    // Gate stdout returns a parseable verdict
    spawnBehavior.stdout = JSON.stringify({
      reason: "found",
      skills: [{ name: "useful-skill", description: "does X", body: "body here" }],
    });
    detectAgentSkillsRoots.mockReturnValueOnce(["/agents-root/skills"]);
    fanOutSymlinks.mockReturnValueOnce(["/agents-root/skills/useful-skill"]);

    const mod = await importOrch();
    await mod.runMineLocal([]);

    expect(spawnCalls).toHaveLength(1);
    expect(writeNewSkill).toHaveBeenCalledTimes(1);
    expect(writeNewSkill.mock.calls[0][0].name).toBe("useful-skill");
    expect(fanOutSymlinks).toHaveBeenCalledTimes(1);
    expect(writeLocalManifest).toHaveBeenCalledTimes(1);
    const manifest = writeLocalManifest.mock.calls[0][0];
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].symlinks).toEqual(["/agents-root/skills/useful-skill"]);
    expect(manifest.entries[0].uploaded).toBe(false);
  });

  it("0 candidates: no writeNewSkill, manifest STILL persisted as one-shot sentinel", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({ reason: "nothing", skills: [] });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(writeNewSkill).not.toHaveBeenCalled();
    // Manifest IS written (empty entries) so the SessionStart auto-spawn
    // doesn't re-fire on every session: the sentinel-existence check gates
    // re-mining, not the entries array.
    expect(writeLocalManifest).toHaveBeenCalledTimes(1);
    const manifest = writeLocalManifest.mock.calls[0][0];
    expect(manifest.entries).toEqual([]);
    expect(typeof manifest.created_at).toBe("string");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No skills to write"));
  });

  it("0 candidates with pre-existing manifest: created_at preserved", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({ reason: "nothing", skills: [] });
    // readLocalManifest is called twice: once by the sentinel check at the
    // top of runMineLocalImpl, once again inside the 0-candidates branch to
    // preserve `created_at`. Both calls must return the existing manifest.
    const existing = {
      created_at: "2026-01-01T00:00:00Z",
      entries: [{ skill_name: "old", canonical_path: "/x", symlinks: [], source_session_ids: [], source_session_paths: [], source_agent: "claude_code", gate_agent: "claude_code", created_at: "2026-01-01T00:00:00Z", uploaded: false }],
    };
    readLocalManifest.mockReturnValue(existing);
    // With manifest existing, runMineLocal exits unless --force is passed.
    const mod = await importOrch();
    await mod.runMineLocal(["--force"]);
    expect(writeLocalManifest).toHaveBeenCalledTimes(1);
    const m = writeLocalManifest.mock.calls[0][0];
    expect(m.created_at).toBe("2026-01-01T00:00:00Z");
    expect(m.entries).toHaveLength(1);
  });

  it("no usable pairs in a session → marked skipped, no gate call for it", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([]); // empty pairs → skipped before gate
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(spawnCalls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("no usable pairs"));
  });

  it("gate errors (non-zero exit) → no candidate, error logged", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.exitCode = 1;
    spawnBehavior.stderr = "agent failed";
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(writeNewSkill).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gate failed"));
  });

  it("gate returns unparseable JSON → no candidate, error logged", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = "this is not JSON";
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(writeNewSkill).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("unparseable verdict"));
  });

  it("overlap with existing skill description → skipped (not written)", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({
      reason: "ok",
      skills: [{ name: "dupe", description: "deeplake schema migration alter table lazy column", body: "x" }],
    });
    // Existing skill with overlapping description
    listSkills.mockReturnValueOnce([{ name: "existing", body: "frontmatter body" }]);
    parseFrontmatter.mockReturnValueOnce({
      fm: { description: "deeplake schema migration alter table lazy column added" },
      body: "",
    });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(writeNewSkill).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("overlaps"));
  });

  it("writeNewSkill throws 'already exists' → logged, no manifest write", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({
      reason: "ok",
      skills: [{ name: "exists", description: "fresh thing", body: "b" }],
    });
    writeNewSkill.mockImplementationOnce(() => {
      throw new Error("Skill already exists at /path");
    });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("file already exists"));
    expect(writeLocalManifest).not.toHaveBeenCalled();
  });

  it("writeNewSkill throws other error → 'failed' branch logged", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({
      reason: "ok",
      skills: [{ name: "permerr", description: "fresh thing", body: "b" }],
    });
    writeNewSkill.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("failed permerr"));
  });

  it("writeNewSkill throws a non-Error value (no .message) → 'failed' branch handles it", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    spawnBehavior.stdout = JSON.stringify({
      reason: "ok",
      skills: [{ name: "weird", description: "fresh thing", body: "b" }],
    });
    // Throw a plain object — covers the `e.message ?? ""` nullish coalesce.
    writeNewSkill.mockImplementationOnce(() => { throw {} as any; });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("failed weird"));
  });

  it("gate returns parseMultiVerdict with null reason → falls through to default string", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    // No 'reason' field at all → parseMultiVerdict returns reason: undefined
    spawnBehavior.stdout = JSON.stringify({ skills: [] });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    // The "no reason given" string is the fallback for the `mv.reason ??` branch.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("no reason given"));
  });

  it("--n all uses all available sessions", async () => {
    const old = Date.now() - 5 * 60_000;
    const sessions = [makeSession("a", old), makeSession("b", old - 1), makeSession("c", old - 2)];
    listLocalSessions.mockReturnValueOnce(sessions);
    pickSessions.mockImplementationOnce((s: any, opts: any) => {
      // confirm n was set to total session count for --n all
      expect(opts.n).toBe(3);
      return [];
    });
    const mod = await importOrch();
    await mod.runMineLocal(["--n", "all", "--dry-run"]);
    expect(pickSessions).toHaveBeenCalled();
  });

  it("--n <num> parses integer", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("a", old)]);
    pickSessions.mockImplementationOnce((_s: any, opts: any) => {
      expect(opts.n).toBe(5);
      return [];
    });
    const mod = await importOrch();
    await mod.runMineLocal(["--n", "5", "--dry-run"]);
  });

  it("--n with non-numeric value falls back to DEFAULT_N", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("a", old)]);
    pickSessions.mockImplementationOnce((_s: any, opts: any) => {
      // parseInt('xyz') → NaN → falls through to DEFAULT_N (8)
      expect(opts.n).toBe(8);
      return [];
    });
    const mod = await importOrch();
    await mod.runMineLocal(["--n", "xyz", "--dry-run"]);
  });

  it("--n missing value → exit 1 (takeFlagValue contract)", async () => {
    const mod = await importOrch();
    // takeFlagValue exits when the value starts with "--"
    await expect(mod.runMineLocal(["--n", "--force"])).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--n requires a value"));
  });

  it("codex-only install (no claude_code) → exits 1 with clear gate-agent error", async () => {
    detectHostAgent.mockReturnValueOnce("codex");
    detectInstalledAgents.mockReturnValueOnce([
      { agent: "codex", sessionRoot: "/c", encodeCwd: () => "x" },
    ]);
    const mod = await importOrch();
    await expect(mod.runMineLocal([])).rejects.toThrow("__exit_1__");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("mine-local v1 requires the Claude Code CLI"));
  });

  it("host = codex but claude_code installed → mining uses claude_code as gate", async () => {
    const old = Date.now() - 5 * 60_000;
    detectHostAgent.mockReturnValueOnce("codex");
    detectInstalledAgents.mockReturnValueOnce([
      { agent: "codex", sessionRoot: "/c", encodeCwd: () => "x" },
      { agent: "claude_code", sessionRoot: "/cc", encodeCwd: () => "x" },
    ]);
    listLocalSessions.mockReturnValueOnce([makeSession("a", old, "codex")]);
    const mod = await importOrch();
    await mod.runMineLocal(["--dry-run"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Gate CLI: claude_code"));
  });

  it("exercises truncate branch with prompts > PAIR_CHAR_CAP (4000)", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    // 5000-char prompt forces truncate's slice+ellipsis branch
    const bigPrompt = "x".repeat(5000);
    extractPairs.mockReturnValue([{ prompt: bigPrompt, answer: "short" }]);
    spawnBehavior.stdout = JSON.stringify({ reason: "ok", skills: [] });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    // The prompt was built — confirm spawn ran with our gate
    expect(spawnCalls).toHaveLength(1);
  });

  it("exercises renderPairsBlock budget-exceeded branch with many large pairs", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    // 30 pairs, each ~5000 chars → total > PER_SESSION_PROMPT_CAP (120,000)
    const bigPrompt = "x".repeat(2500);
    const bigAnswer = "y".repeat(2500);
    const pairs = Array.from({ length: 30 }, () => ({ prompt: bigPrompt, answer: bigAnswer }));
    extractPairs.mockReturnValue(pairs);
    spawnBehavior.stdout = JSON.stringify({ reason: "ok", skills: [] });
    const mod = await importOrch();
    await mod.runMineLocal([]);
    expect(spawnCalls).toHaveLength(1);
  });

  it("releases lock on exit (via process.on('exit') handler)", async () => {
    // Plant a fake lock file
    const fakeLockDir = join(tmpHome, ".claude", "hivemind");
    // We can't easily redirect LOCAL_MINE_LOCK_PATH (it's HOME-baked), but we
    // can at least exercise the runMineLocal wrapper code path and confirm
    // it doesn't throw. The actual unlink runs against the developer's HOME
    // path and silently no-ops on ENOENT.
    detectInstalledAgents.mockReturnValueOnce([]);
    const mod = await importOrch();
    await expect(mod.runMineLocal([])).rejects.toThrow("__exit_1__");
    // No assertion beyond "no unhandled rejection" — the lock-release branch
    // is wrapped in try/catch and intentionally silent.
  });
});

describe("runGateViaStdin error branches via orchestrator", () => {
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mine-local-stdin-"));
    spawnCalls = [];
    spawnBehavior = { exitCode: 0 };
    vi.clearAllMocks();
    detectInstalledAgents.mockReturnValue([
      { agent: "claude_code", sessionRoot: "/fake", encodeCwd: () => "x" },
    ]);
    detectHostAgent.mockReturnValue("claude_code");
    listLocalSessions.mockReturnValue([]);
    pickSessions.mockImplementation((s) => s);
    nativeJsonlToRows.mockReturnValue([]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    findAgentBin.mockReturnValue(process.execPath);
    resolveSkillsRoot.mockReturnValue(join(tmpHome, "skills"));
    listSkills.mockReturnValue([]);
    parseFrontmatter.mockReturnValue({ fm: { description: "" }, body: "" });
    detectAgentSkillsRoots.mockReturnValue([]);
    fanOutSymlinks.mockReturnValue([]);
    readLocalManifest.mockReturnValue(null);
    writeLocalManifest.mockImplementation(() => {});
    writeNewSkill.mockImplementation((opts: any) => ({
      path: join(opts.skillsRoot, opts.name, "SKILL.md"),
      createdAt: "2026-05-15T00:00:00Z",
    }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
    process.removeAllListeners("exit");
  });

  it("spawn-emits 'error' event → gate failed with error.message", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    spawnBehavior.emitError = new Error("ENOENT spawning gate");
    const mod = await import("../../src/commands/mine-local.js");
    await mod.runMineLocal([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ENOENT spawning gate"));
  });

  it("stdin emits 'error' event → gate failed with 'stdin write failed:' prefix", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    spawnBehavior.stdinError = new Error("EPIPE");
    const mod = await import("../../src/commands/mine-local.js");
    await mod.runMineLocal([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("stdin write failed"));
  });

  it("gate bin missing on disk → errored=true short-circuit (no spawn)", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("aaaaaaaa", old)]);
    findAgentBin.mockReturnValueOnce("/definitely/does/not/exist/claude");
    const mod = await import("../../src/commands/mine-local.js");
    await mod.runMineLocal([]);
    expect(spawnCalls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("agent binary not found"));
  });
});

describe("happy-path with already-existing skill check (loadExistingSummaries)", () => {
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mine-local-orch2-"));
    spawnCalls = [];
    spawnBehavior = { exitCode: 0 };
    vi.clearAllMocks();
    detectInstalledAgents.mockReturnValue([
      { agent: "claude_code", sessionRoot: "/fake", encodeCwd: () => "x" },
    ]);
    detectHostAgent.mockReturnValue("claude_code");
    pickSessions.mockImplementation((s) => s);
    nativeJsonlToRows.mockReturnValue([]);
    extractPairs.mockReturnValue([{ prompt: "p", answer: "a" }]);
    findAgentBin.mockReturnValue(process.execPath);
    resolveSkillsRoot.mockReturnValue(join(tmpHome, "skills"));
    detectAgentSkillsRoots.mockReturnValue([]);
    fanOutSymlinks.mockReturnValue([]);
    readLocalManifest.mockReturnValue(null);
    writeLocalManifest.mockImplementation(() => {});
    writeNewSkill.mockImplementation((opts: any) => ({
      path: join(opts.skillsRoot, opts.name, "SKILL.md"),
      createdAt: "2026-05-15T00:00:00Z",
    }));

    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
    process.removeAllListeners("exit");
  });

  it("existing skills without description are skipped in baseline", async () => {
    const old = Date.now() - 5 * 60_000;
    listLocalSessions.mockReturnValueOnce([makeSession("a", old)]);
    spawnBehavior.stdout = JSON.stringify({
      reason: "ok",
      skills: [{ name: "new-skill", description: "totally fresh content", body: "b" }],
    });
    listSkills.mockReturnValueOnce([
      { name: "noDescSkill", body: "no frontmatter" },
      { name: "hasDescSkill", body: "with frontmatter" },
    ]);
    // First call → undefined description (filtered out of baseline)
    parseFrontmatter
      .mockReturnValueOnce({ fm: {}, body: "" })
      // Second call → with description
      .mockReturnValueOnce({ fm: { description: "unrelated topic about React" }, body: "" });

    const mod = await import("../../src/commands/mine-local.js");
    await mod.runMineLocal([]);
    // The skill is fresh → should be written
    expect(writeNewSkill).toHaveBeenCalled();
  });
});
