/**
 * Unit tests for src/skillify/local-source.ts — pure helpers used by
 * `hivemind skillify mine-local`. We test the in-memory functions
 * (pickSessions, nativeJsonlToRows) with synthetic data; filesystem-touching
 * helpers (listLocalSessions, detectInstalledAgents) are exercised via the
 * mine-local e2e flow instead of mocked here.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSessions, nativeJsonlToRows, listLocalSessions, type SessionFile, type AgentInstall } from "../../src/skillify/local-source.js";

function makeSession(id: string, mtime: number, inCwd: boolean): SessionFile {
  return {
    agent: "claude_code",
    path: `/sessions/${id}.jsonl`,
    mtime,
    inCwd,
    sessionId: id,
  };
}

describe("pickSessions", () => {
  it("returns [] for empty candidates", () => {
    expect(pickSessions([], { n: 5, epsilon: 0.3 })).toEqual([]);
  });

  it("returns [] for n <= 0", () => {
    const sessions = [makeSession("a", 1, true)];
    expect(pickSessions(sessions, { n: 0, epsilon: 0.3 })).toEqual([]);
    expect(pickSessions(sessions, { n: -3, epsilon: 0.3 })).toEqual([]);
  });

  it("all-in-cwd: cwd quota fills, top-up grabs the rest from cwd", () => {
    // 10 cwd sessions, 0 global. N=10, ε=0.3 → cwd quota=7, global=0, top-up=3 more from cwd.
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`c${i}`, 100 - i, true), // newest first by mtime
    );
    const picked = pickSessions(sessions, { n: 10, epsilon: 0.3 });
    expect(picked).toHaveLength(10);
    // All from cwd, in mtime-desc order
    expect(picked.every(s => s.inCwd)).toBe(true);
    expect(picked.map(s => s.sessionId)).toEqual(sessions.map(s => s.sessionId));
  });

  it("none-in-cwd: cwd quota empty, global+top-up fill everything", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`g${i}`, 100 - i, false),
    );
    const picked = pickSessions(sessions, { n: 10, epsilon: 0.3 });
    expect(picked).toHaveLength(10);
    expect(picked.every(s => !s.inCwd)).toBe(true);
  });

  it("mixed: cwd-biased per ε with global top-up", () => {
    // 7 cwd (older), 3 global (newer). N=10, ε=0.3 → cwd quota ⌈7⌉, global ⌊3⌋.
    const cwd = Array.from({ length: 7 }, (_, i) => makeSession(`c${i}`, 50 - i, true));
    const global_ = Array.from({ length: 3 }, (_, i) => makeSession(`g${i}`, 100 - i, false));
    const picked = pickSessions([...cwd, ...global_], { n: 10, epsilon: 0.3 });
    expect(picked).toHaveLength(10);
    expect(picked.filter(s => s.inCwd)).toHaveLength(7);
    expect(picked.filter(s => !s.inCwd)).toHaveLength(3);
  });

  it("dedup by path: same file never appears twice across phases", () => {
    // A path appears in both buckets (shouldn't happen in practice, but the
    // contract says dedup by absolute path).
    const dupe = makeSession("dupe", 100, true);
    const others = [makeSession("a", 99, true), makeSession("b", 98, false)];
    const picked = pickSessions([dupe, dupe, ...others], { n: 5, epsilon: 0.5 });
    const paths = picked.map(s => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("n larger than total returns everything once", () => {
    const sessions = [makeSession("a", 3, true), makeSession("b", 2, false), makeSession("c", 1, true)];
    const picked = pickSessions(sessions, { n: 100, epsilon: 0.3 });
    expect(picked).toHaveLength(3);
  });

  it("newest-first ordering within picked", () => {
    const sessions = [
      makeSession("oldest", 10, false),
      makeSession("middle", 20, false),
      makeSession("newest", 30, false),
    ];
    const picked = pickSessions(sessions, { n: 3, epsilon: 0.3 });
    expect(picked.map(s => s.sessionId)).toEqual(["newest", "middle", "oldest"]);
  });
});

/** Write a JSONL file with the given lines and return its path. */
function writeJsonl(dir: string, name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("nativeJsonlToRows", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mine-local-test-"));

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("returns [] for missing file", () => {
    expect(nativeJsonlToRows(join(tmpDir, "does-not-exist.jsonl"), "sid", "claude_code")).toEqual([]);
  });

  it("emits one user_message per string-content user line", () => {
    const path = writeJsonl(tmpDir, "user-only.jsonl", [
      { type: "user", message: { content: "hello" }, timestamp: "2026-05-13T00:00:00Z" },
      { type: "user", message: { content: "world" }, timestamp: "2026-05-13T00:00:01Z" },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.type === "user_message")).toBe(true);
    expect(rows.map(r => r.content)).toEqual(["hello", "world"]);
  });

  it("drops user messages whose content is an array (tool results)", () => {
    const path = writeJsonl(tmpDir, "user-array.jsonl", [
      { type: "user", message: { content: [{ type: "tool_result", content: "..." }] } },
      { type: "user", message: { content: "real prompt" } },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("real prompt");
  });

  it("assistant: emits ONLY the last text-bearing entry per turn (last_assistant_message semantics)", () => {
    const path = writeJsonl(tmpDir, "asst-multi.jsonl", [
      { type: "user", message: { content: "do thing" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Let me check…" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Now I'll run it" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Final answer here" }] } },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("user_message");
    expect(rows[1].type).toBe("assistant_message");
    expect(rows[1].content).toBe("Final answer here");
  });

  it("assistant: drops thinking + tool_use blocks, joins multiple text blocks in same entry", () => {
    const path = writeJsonl(tmpDir, "asst-mixed.jsonl", [
      { type: "user", message: { content: "ask" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "internal monologue" },
            { type: "text", text: "first part" },
            { type: "tool_use", id: "x", name: "Read", input: {} },
            { type: "text", text: "second part" },
          ],
        },
      },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(2);
    expect(rows[1].type).toBe("assistant_message");
    expect(rows[1].content).toBe("first part\n\nsecond part");
  });

  it("flushes pending assistant text at EOF (no trailing user message)", () => {
    const path = writeJsonl(tmpDir, "asst-eof.jsonl", [
      { type: "user", message: { content: "ask" } },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows.map(r => r.type)).toEqual(["user_message", "assistant_message"]);
  });

  it("skips malformed JSON lines silently", () => {
    const path = join(tmpDir, "malformed.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "ok" } }),
        "this is not json",
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reply" }] } }),
      ].join("\n"),
    );
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(2);
  });

  it("skips non-user/non-assistant lines (system, attachment, etc.)", () => {
    const path = writeJsonl(tmpDir, "noise.jsonl", [
      { type: "system" },
      { type: "attachment", path: "foo.png" },
      { type: "last-prompt" },
      { type: "user", message: { content: "the only real one" } },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    ]);
    const rows = nativeJsonlToRows(path, "sid", "claude_code");
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe("the only real one");
  });
});

describe("listLocalSessions", () => {
  const root = mkdtempSync(join(tmpdir(), "list-local-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("returns [] when sessionRoot does not exist", () => {
    const installs: AgentInstall[] = [{
      agent: "claude_code",
      sessionRoot: join(root, "does-not-exist"),
      encodeCwd: (cwd) => cwd.replace(/[/_]/g, "-"),
    }];
    expect(listLocalSessions(installs, "/some/cwd")).toEqual([]);
  });

  it("walks subdirs and collects .jsonl files, tagging inCwd correctly", () => {
    const sessionRoot = join(root, "scenario1");
    const cwdSub = "-home-foo-bar";
    const otherSub = "-other-project";
    mkdirSync(join(sessionRoot, cwdSub), { recursive: true });
    mkdirSync(join(sessionRoot, otherSub), { recursive: true });
    writeFileSync(join(sessionRoot, cwdSub, "session-a.jsonl"), "");
    writeFileSync(join(sessionRoot, cwdSub, "session-b.jsonl"), "");
    writeFileSync(join(sessionRoot, otherSub, "session-c.jsonl"), "");
    // non-jsonl file should be skipped
    writeFileSync(join(sessionRoot, otherSub, "notes.txt"), "ignored");

    const installs: AgentInstall[] = [{
      agent: "claude_code",
      sessionRoot,
      encodeCwd: () => cwdSub,
    }];
    const out = listLocalSessions(installs, "/home/foo/bar");
    expect(out).toHaveLength(3);
    const aRow = out.find(s => s.sessionId === "session-a");
    const cRow = out.find(s => s.sessionId === "session-c");
    expect(aRow?.inCwd).toBe(true);
    expect(cRow?.inCwd).toBe(false);
    expect(out.every(s => s.path.endsWith(".jsonl"))).toBe(true);
    expect(out.every(s => typeof s.mtime === "number")).toBe(true);
  });

  it("skips entries that are not directories (e.g. stray files at root)", () => {
    const sessionRoot = join(root, "scenario2");
    mkdirSync(sessionRoot, { recursive: true });
    // A file directly under sessionRoot — not a subdir
    writeFileSync(join(sessionRoot, "stray.txt"), "noise");
    // A real subdir with one session
    mkdirSync(join(sessionRoot, "real"), { recursive: true });
    writeFileSync(join(sessionRoot, "real", "s.jsonl"), "");

    const installs: AgentInstall[] = [{
      agent: "claude_code",
      sessionRoot,
      encodeCwd: () => "irrelevant",
    }];
    const out = listLocalSessions(installs, "/any");
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("s");
  });

  it("aggregates across multiple installs", () => {
    const rootA = join(root, "agentA");
    const rootB = join(root, "agentB");
    mkdirSync(join(rootA, "subA"), { recursive: true });
    mkdirSync(join(rootB, "subB"), { recursive: true });
    writeFileSync(join(rootA, "subA", "a1.jsonl"), "");
    writeFileSync(join(rootB, "subB", "b1.jsonl"), "");

    const installs: AgentInstall[] = [
      { agent: "claude_code", sessionRoot: rootA, encodeCwd: () => "subA" },
      { agent: "codex", sessionRoot: rootB, encodeCwd: () => "__cwd_unknown__" },
    ];
    const out = listLocalSessions(installs, "/cwd");
    expect(out.map(s => s.agent).sort()).toEqual(["claude_code", "codex"]);
  });
});

describe("detectInstalledAgents + detectHostAgent + encodeCwdClaudeCode", () => {
  let tmpHome: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "detect-agents-"));
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
  });

  async function importWithMockedHome(home: string) {
    vi.doMock("node:os", async (orig) => {
      const actual = await orig<typeof import("node:os")>();
      return { ...actual, homedir: () => home };
    });
    return await import("../../src/skillify/local-source.js");
  }

  it("detectInstalledAgents: no agents installed → empty", async () => {
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectInstalledAgents()).toEqual([]);
  });

  it("detectInstalledAgents: claude_code only", async () => {
    mkdirSync(join(tmpHome, ".claude", "projects"), { recursive: true });
    const mod = await importWithMockedHome(tmpHome);
    const installs = mod.detectInstalledAgents();
    expect(installs).toHaveLength(1);
    expect(installs[0].agent).toBe("claude_code");
    expect(installs[0].sessionRoot).toBe(join(tmpHome, ".claude", "projects"));
    // encodeCwdClaudeCode: both '/' and '_' become '-'
    expect(installs[0].encodeCwd("/home/foo/my_project")).toBe("-home-foo-my-project");
  });

  it("detectInstalledAgents: codex only", async () => {
    mkdirSync(join(tmpHome, ".codex", "sessions"), { recursive: true });
    const mod = await importWithMockedHome(tmpHome);
    const installs = mod.detectInstalledAgents();
    expect(installs).toHaveLength(1);
    expect(installs[0].agent).toBe("codex");
    expect(installs[0].encodeCwd("/anything")).toBe("__cwd_unknown__");
  });

  it("detectInstalledAgents: both claude_code and codex", async () => {
    mkdirSync(join(tmpHome, ".claude", "projects"), { recursive: true });
    mkdirSync(join(tmpHome, ".codex", "sessions"), { recursive: true });
    const mod = await importWithMockedHome(tmpHome);
    const installs = mod.detectInstalledAgents();
    expect(installs.map(i => i.agent).sort()).toEqual(["claude_code", "codex"]);
  });

  it("detectHostAgent: returns claude_code via CLAUDECODE=1", async () => {
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDECODE = "1";
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectHostAgent()).toBe("claude_code");
  });

  it("detectHostAgent: returns claude_code via CLAUDE_CODE_ENTRYPOINT", async () => {
    delete process.env.CLAUDECODE;
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SESSION_ID;
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectHostAgent()).toBe("claude_code");
  });

  it("detectHostAgent: returns codex via CODEX_HOME", async () => {
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CODEX_SESSION_ID;
    process.env.CODEX_HOME = "/some/path";
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectHostAgent()).toBe("codex");
  });

  it("detectHostAgent: returns codex via CODEX_SESSION_ID", async () => {
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CODEX_HOME;
    process.env.CODEX_SESSION_ID = "abc";
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectHostAgent()).toBe("codex");
  });

  it("detectHostAgent: returns null when no agent env vars are set", async () => {
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SESSION_ID;
    const mod = await importWithMockedHome(tmpHome);
    expect(mod.detectHostAgent()).toBeNull();
  });
});

