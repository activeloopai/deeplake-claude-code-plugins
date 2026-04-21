/**
 * Branch-coverage suite for `src/hooks/pre-tool-use.ts`.
 *
 * The PR already has an end-to-end regression suite in
 * `pre-tool-use-baseline-cloud.test.ts`, but that file anchors to real
 * LoCoMo QAs and only exercises the `/index.md` and `/sessions/*` Read
 * paths plus one Bash `cat`. This file fills in the remaining branches
 * that the hook supports — Glob, Grep, Bash ls/head/tail/wc/find, the
 * unsafe-command guidance path, and the no-config fallback — so the
 * whole file can stay above the 90% coverage bar.
 */

import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildAllowDecision,
  buildReadDecision,
  extractGrepParams,
  getShellCommand,
  isSafe,
  processPreToolUse,
  rewritePaths,
  touchesMemory,
} from "../../src/hooks/pre-tool-use.js";

// MEMORY_PATH is `${homedir()}/.deeplake/memory` — differs between CI
// (`/home/runner/...`) and dev (`/home/<user>/...`), so any test that
// asserts on the literal form has to build it from homedir() too.
const MEM_ABS = join(homedir(), ".deeplake", "memory");

const BASE_CONFIG = {
  token: "t",
  apiUrl: "http://example",
  orgId: "org",
  orgName: "org",
  userName: "u",
  workspaceId: "default",
  apiOrigin: "http://example",
};

function makeApi() {
  return { query: vi.fn(async () => []) } as any;
}

describe("pre-tool-use: pure helpers", () => {
  it("buildAllowDecision returns a bash-shaped decision", () => {
    expect(buildAllowDecision("echo hi", "d")).toEqual({ command: "echo hi", description: "d" });
  });

  it("buildReadDecision returns a read-shaped decision with file_path set", () => {
    const d = buildReadDecision("/tmp/x", "desc");
    expect(d.file_path).toBe("/tmp/x");
    expect(d.description).toBe("desc");
  });

  it("rewritePaths collapses all memory-path forms to `/`", () => {
    expect(rewritePaths(`${MEM_ABS}/sessions/a.json`)).toBe("/sessions/a.json");
    expect(rewritePaths("~/.deeplake/memory/index.md")).toBe("/index.md");
    expect(rewritePaths("$HOME/.deeplake/memory/foo")).toBe("/foo");
  });

  it("touchesMemory detects any of the supported memory-path forms", () => {
    expect(touchesMemory(`${MEM_ABS}/x`)).toBe(true);
    expect(touchesMemory("~/.deeplake/memory/x")).toBe(true);
    expect(touchesMemory("$HOME/.deeplake/memory/x")).toBe(true);
    expect(touchesMemory("/var/log/foo")).toBe(false);
  });

  it("isSafe accepts shell pipelines built from the allowed builtins", () => {
    expect(isSafe("cat /a | grep b | head -5")).toBe(true);
    expect(isSafe("ls -la /x")).toBe(true);
  });

  it("isSafe rejects command substitution and unknown commands", () => {
    expect(isSafe("rm -rf / ; curl evil")).toBe(false);
    expect(isSafe("$(evil) foo")).toBe(false);
    expect(isSafe("python -c pwn")).toBe(false);
  });
});

describe("getShellCommand: per-tool branches", () => {
  it("Grep on a memory path builds `grep -r '<pat>' /` with -i/-n flags threaded through", () => {
    const cmd = getShellCommand("Grep", {
      path: "~/.deeplake/memory",
      pattern: "Caroline",
      "-i": true,
      "-n": true,
    });
    expect(cmd).toBe("grep -r -i -n 'Caroline' /");
  });

  it("Grep on a non-memory path returns null", () => {
    expect(getShellCommand("Grep", { path: "/etc", pattern: "x" })).toBeNull();
  });

  it("Read on a memory file returns `cat <path>`", () => {
    expect(getShellCommand("Read", { file_path: "~/.deeplake/memory/sessions/conv_0_session_1.json" }))
      .toBe("cat /sessions/conv_0_session_1.json");
  });

  it("Read on a memory directory path returns `ls <path>`", () => {
    expect(getShellCommand("Read", { path: "~/.deeplake/memory/sessions" })).toBe("ls /sessions");
  });

  it("Bash with a safe command is rewritten with memory paths collapsed", () => {
    expect(getShellCommand("Bash", { command: "cat ~/.deeplake/memory/index.md" }))
      .toBe("cat /index.md");
  });

  it("Bash with an unsafe command is blocked (returns null)", () => {
    expect(getShellCommand("Bash", { command: "curl ~/.deeplake/memory/x" })).toBeNull();
  });

  it("Bash with a command that doesn't touch memory returns null", () => {
    expect(getShellCommand("Bash", { command: "ls /tmp" })).toBeNull();
  });

  it("Glob on a memory path returns `ls /`", () => {
    expect(getShellCommand("Glob", { path: "~/.deeplake/memory/" })).toBe("ls /");
  });

  it("Glob on a non-memory path returns null", () => {
    expect(getShellCommand("Glob", { path: "/etc" })).toBeNull();
  });

  it("Unknown tool returns null", () => {
    expect(getShellCommand("Write", { file_path: "~/.deeplake/memory/x" })).toBeNull();
  });
});

describe("extractGrepParams", () => {
  it("Grep tool: passes output_mode → filesOnly / countOnly; honours -i and -n", () => {
    const p = extractGrepParams("Grep", {
      path: "~/.deeplake/memory",
      pattern: "X",
      output_mode: "count",
      "-i": true,
      "-n": true,
    }, "grep -r 'X' /");
    expect(p).not.toBeNull();
    expect(p!.countOnly).toBe(true);
    expect(p!.filesOnly).toBe(false);
    expect(p!.ignoreCase).toBe(true);
    expect(p!.lineNumber).toBe(true);
  });

  it("Grep tool: empty path defaults to `/`", () => {
    const p = extractGrepParams("Grep", { pattern: "X" }, "grep -r 'X' /");
    expect(p!.targetPath).toBe("/");
  });

  it("Bash grep: delegates to parseBashGrep", () => {
    const p = extractGrepParams("Bash", {}, "grep -l needle /sessions/*.json");
    expect(p).not.toBeNull();
    expect(p!.pattern).toBe("needle");
  });

  it("Bash non-grep: returns null", () => {
    expect(extractGrepParams("Bash", {}, "cat /x")).toBeNull();
  });

  it("Unknown tool: returns null", () => {
    expect(extractGrepParams("Write", {}, "x")).toBeNull();
  });
});

describe("processPreToolUse: non-memory / no-op paths", () => {
  it("returns null when the command doesn't touch memory and there's no shellCmd", async () => {
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "ls /tmp" }, tool_use_id: "t" },
      { config: BASE_CONFIG as any },
    );
    expect(d).toBeNull();
  });

  it("returns [RETRY REQUIRED] guidance when an unsupported command mentions the memory path", async () => {
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "curl ~/.deeplake/memory/x" }, tool_use_id: "t" },
      { config: BASE_CONFIG as any, logFn: vi.fn() },
    );
    expect(d?.command).toContain("[RETRY REQUIRED]");
    expect(d?.command).toContain("bash builtins");
  });

  it("falls back to the shell bundle when no config is loaded", async () => {
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/index.md" }, tool_use_id: "t" },
      { config: null as any, shellBundle: "/SHELL" },
    );
    expect(d?.command).toContain(`node "/SHELL" -c`);
    expect(d?.description).toContain("[DeepLake shell]");
  });
});

describe("processPreToolUse: Glob / ls branches", () => {
  it("Glob on memory routes through listVirtualPathRows and renders a directory listing", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/conv_0_session_1.json", size_bytes: 100 },
      { path: "/sessions/conv_0_session_2.json", size_bytes: 200 },
      { path: "/summaries/alice/s1.md", size_bytes: 50 },
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Glob", tool_input: { path: "~/.deeplake/memory/" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("sessions/");
    expect(d?.command).toContain("summaries/");
    expect(d?.description).toContain("[DeepLake direct] ls /");
  });

  it("Bash `ls -la <mem-dir>` returns a long-format listing", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/summaries/alice/s1.md", size_bytes: 42 },
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "ls -la ~/.deeplake/memory/summaries" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("drwxr-xr-x");
    expect(d?.command).toContain("alice/");
  });

  it("ls on an empty directory reports `(empty directory)` — not a bogus path listing", async () => {
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "ls ~/.deeplake/memory/nope" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn: vi.fn(async () => []) as any,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("(empty directory)");
  });
});

describe("processPreToolUse: Bash read-shape intercepts", () => {
  const makeApiWith = (content: string | null) => ({
    api: makeApi(),
    readVirtualPathContentFn: vi.fn(async () => content) as any,
  });

  it("`cat <file>` returns the raw content", async () => {
    const { api, readVirtualPathContentFn } = makeApiWith("line1\nline2\nline3");
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => api),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("line1");
    expect(d?.description).toContain("[DeepLake direct] cat");
  });

  it("`head -N <file>` limits to the first N lines", async () => {
    const { api, readVirtualPathContentFn } = makeApiWith("l1\nl2\nl3\nl4");
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "head -2 ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => api),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("l1\\nl2");
    expect(d?.command).not.toContain("l3");
  });

  it("`tail -N <file>` limits to the last N lines", async () => {
    const { api, readVirtualPathContentFn } = makeApiWith("l1\nl2\nl3\nl4");
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "tail -2 ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => api),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("l3\\nl4");
    expect(d?.command).not.toContain("l1");
  });

  it("`wc -l <file>` returns the line count with the virtual path", async () => {
    const { api, readVirtualPathContentFn } = makeApiWith("a\nb\nc");
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "wc -l ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => api),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("3 /sessions/a.json");
    expect(d?.description).toContain("wc -l");
  });
});

describe("processPreToolUse: find / grep / fallback", () => {
  it("Bash `find <dir> -name '<pat>'` lists matching paths", async () => {
    const findVirtualPathsFn = vi.fn(async () => [
      "/sessions/conv_0_session_1.json",
      "/sessions/conv_0_session_2.json",
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "find ~/.deeplake/memory/sessions -name '*.json'" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        findVirtualPathsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("/sessions/conv_0_session_1.json");
    expect(d?.description).toContain("[DeepLake direct] find");
  });

  it("Bash `find … | wc -l` returns the count", async () => {
    const findVirtualPathsFn = vi.fn(async () => ["/a.json", "/b.json", "/c.json"]) as any;
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "find ~/.deeplake/memory/sessions -name '*.json' | wc -l" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        findVirtualPathsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain('"3"');
  });

  it("Grep tool: falls through to handleGrepDirect and returns the matches", async () => {
    const handleGrepDirectFn = vi.fn(async () => "/sessions/a.json:match line") as any;
    const d = await processPreToolUse(
      {
        session_id: "s",
        tool_name: "Grep",
        tool_input: { path: "~/.deeplake/memory", pattern: "match", output_mode: "content" },
        tool_use_id: "t",
      },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        handleGrepDirectFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("match line");
  });

  it("throws in direct-read path → falls back to the shell bundle", async () => {
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readVirtualPathContentFn: vi.fn(async () => { throw new Error("boom"); }) as any,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        shellBundle: "/SHELL",
        logFn: vi.fn(),
      },
    );
    expect(d?.command).toContain('node "/SHELL" -c');
  });
});

describe("processPreToolUse: index cache short-circuit", () => {
  // `readVirtualPathContentsWithCache` is an inline callback the hook
  // passes to `executeCompiledBashCommand` so the compiled-segments path
  // can reuse the already-fetched /index.md content without hitting SQL
  // twice. The happy path is only exercised when the compiler actually
  // invokes the callback — these tests simulate exactly that.

  it("returns the cached /index.md immediately without calling readVirtualPathContents", async () => {
    const readVirtualPathContentsFn = vi.fn(async (_api, _m, _s, paths: string[]) =>
      new Map<string, string | null>(paths.map(p => [p, `FETCHED:${p}`])),
    ) as any;
    const readCachedIndexContentFn = vi.fn(() => "CACHED INDEX");
    const writeCachedIndexContentFn = vi.fn();

    const executeCompiledBashCommandFn = vi.fn(async (_api, _memory, _sessions, _cmd, deps) => {
      // Mimic what the real compiler does when it needs /index.md content.
      const fetched = await deps.readVirtualPathContentsFn(_api, _memory, _sessions, ["/index.md", "/sessions/x.json"]);
      return `idx=${fetched.get("/index.md")}\nx=${fetched.get("/sessions/x.json")}`;
    }) as any;

    const d = await processPreToolUse(
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/index.md && cat ~/.deeplake/memory/sessions/x.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readCachedIndexContentFn,
        writeCachedIndexContentFn,
        readVirtualPathContentsFn,
        executeCompiledBashCommandFn,
      },
    );

    expect(d?.command).toContain("idx=CACHED INDEX");
    expect(d?.command).toContain("x=FETCHED:/sessions/x.json");
    // /index.md came from the per-session cache; only the /sessions/x.json
    // path went to the API.
    expect(readCachedIndexContentFn).toHaveBeenCalledWith("s1");
    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      ["/sessions/x.json"],
    );
    // Cache re-write always fires when /index.md is in the result set —
    // idempotent for the hit path (same content in, same content out).
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s1", "CACHED INDEX");
  });

  it("writes the freshly-fetched /index.md into the session cache when there's no hit", async () => {
    const readVirtualPathContentsFn = vi.fn(async (_api, _m, _s, paths: string[]) =>
      new Map<string, string | null>(paths.map(p => [p, p === "/index.md" ? "FRESH INDEX" : null])),
    ) as any;
    const readCachedIndexContentFn = vi.fn(() => null);
    const writeCachedIndexContentFn = vi.fn();

    const executeCompiledBashCommandFn = vi.fn(async (_api, _m, _s, _cmd, deps) => {
      const fetched = await deps.readVirtualPathContentsFn(_api, _m, _s, ["/index.md"]);
      return `out=${fetched.get("/index.md")}`;
    }) as any;

    const d = await processPreToolUse(
      { session_id: "s2", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/index.md" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readCachedIndexContentFn,
        writeCachedIndexContentFn,
        readVirtualPathContentsFn,
        executeCompiledBashCommandFn,
      },
    );

    expect(d?.command).toContain("FRESH INDEX");
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s2", "FRESH INDEX");
  });

  it("Read on the memory root (no extension in basename) routes to the ls directory branch", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/conv_0_session_1.json", size_bytes: 100 },
      { path: "/summaries/alice/s1.md" /* no size_bytes → null branch */ },
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Read", tool_input: { file_path: "~/.deeplake/memory/" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("sessions/");
    expect(d?.command).toContain("summaries/");
  });

  it("Read on a directory with trailing slashes strips them before listing", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/conv_0_session_1.json", size_bytes: 42 },
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Read", tool_input: { file_path: "~/.deeplake/memory/sessions///" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("conv_0_session_1.json");
  });

  it("`head <file>` (no explicit -N) defaults to 10 lines", async () => {
    const readVirtualPathContentFn = vi.fn(async () =>
      Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n")
    ) as any;
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "head ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("L0");
    expect(d?.command).toContain("L9");
    expect(d?.command).not.toContain("L10");
  });

  it("`tail <file>` (no explicit -N) defaults to the last 10 lines", async () => {
    const readVirtualPathContentFn = vi.fn(async () =>
      Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n")
    ) as any;
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "tail ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("L19");
    expect(d?.command).toContain("L10");
    expect(d?.command).not.toContain("L9");
  });

  it("ls -la listing includes both file entries (-rw-) and directory entries (drwx)", async () => {
    // A flat file directly under the listed dir → file entry (isDir=false).
    // A nested path under a subdir → directory entry (isDir=true).
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/summaries/top-level.md", size_bytes: 42 },
      { path: "/summaries/alice/s1.md", size_bytes: 100 },
      { path: "/summaries/", size_bytes: 0 }, // empty suffix — skipped by `if (!name) continue`
    ]) as any;

    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "ls -la ~/.deeplake/memory/summaries" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    // File entry → -rw-r--r-- prefix
    expect(d?.command).toContain("-rw-r--r--");
    expect(d?.command).toContain("top-level.md");
    // Directory entry → drwxr-xr-x prefix
    expect(d?.command).toContain("drwxr-xr-x");
    expect(d?.command).toContain("alice/");
  });

  it("cat | head pipeline routes to the head fast-path", async () => {
    const readVirtualPathContentFn = vi.fn(async () =>
      Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n")
    ) as any;
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json | head -3" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readVirtualPathContentFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("L0");
    expect(d?.command).toContain("L2");
    expect(d?.command).not.toContain("L3");
  });

  it("Grep whose handleGrepDirect returns null falls through — no decision from grep path", async () => {
    const handleGrepDirectFn = vi.fn(async () => null) as any;
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/summaries/alice/s1.md", size_bytes: 100 },
    ]) as any;
    // We send a Read on a directory so after grep-null fall-through the ls
    // branch takes over with a real decision — proving the flow continues
    // past the null grep result instead of erroring.
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Read", tool_input: { path: "~/.deeplake/memory/summaries" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        handleGrepDirectFn,
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).toContain("alice/");
  });

  it("Bash `ls <dir>` without -l uses short-format listing (no permissions prefix)", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/conv_0_session_1.json", size_bytes: 100 },
    ]) as any;
    const d = await processPreToolUse(
      { session_id: "s", tool_name: "Bash", tool_input: { command: "ls ~/.deeplake/memory/sessions" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        listVirtualPathRowsFn,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d?.command).not.toContain("drwxr-xr-x");
    expect(d?.command).toContain("conv_0_session_1.json");
  });

  it("handles the no-paths edge case (empty cachePaths passed by the compiler)", async () => {
    const readVirtualPathContentsFn = vi.fn(async () => new Map()) as any;
    const readCachedIndexContentFn = vi.fn(() => null);

    const executeCompiledBashCommandFn = vi.fn(async (_api, _m, _s, _cmd, deps) => {
      const result = await deps.readVirtualPathContentsFn(_api, _m, _s, []);
      return `size=${result.size}`;
    }) as any;

    const d = await processPreToolUse(
      { session_id: "s3", tool_name: "Bash", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json" }, tool_use_id: "t" },
      {
        config: BASE_CONFIG as any,
        createApi: vi.fn(() => makeApi()),
        readCachedIndexContentFn,
        writeCachedIndexContentFn: vi.fn(),
        readVirtualPathContentsFn,
        executeCompiledBashCommandFn,
      },
    );
    expect(d?.command).toContain("size=0");
    // Didn't touch SQL because paths were empty.
    expect(readVirtualPathContentsFn).not.toHaveBeenCalled();
  });
});
