/**
 * Branch-coverage suite for `src/hooks/codex/pre-tool-use.ts`.
 *
 * The codex hook mirrors the Claude Code pre-tool-use hook's routing
 * logic but has its own decision shape (`action: "pass" | "guide" |
 * "block"`) and a single Bash-command input (no separate Read tool).
 * Before this suite the file sat at 0% coverage. This file drives the
 * real `processCodexPreToolUse` entry point across every branch
 * that the hook supports — not smoke tests, actual routing + content
 * assertions per-branch.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildUnsupportedGuidance,
  processCodexPreToolUse,
  runVirtualShell,
} from "../../src/hooks/codex/pre-tool-use.js";

const BASE_CONFIG = {
  token: "t",
  apiUrl: "http://example",
  orgId: "org",
  orgName: "org",
  userName: "u",
  workspaceId: "default",
};

function makeApi(queryResponses: Record<string, unknown>[] | ((sql: string) => Record<string, unknown>[]) = []) {
  return {
    query: vi.fn(async (sql: string) =>
      typeof queryResponses === "function" ? queryResponses(sql) : queryResponses,
    ),
  } as any;
}

/** Base deps every test wants: neutral cache (no hit) + log silent. */
function baseDeps(extra: Record<string, any> = {}) {
  return {
    config: BASE_CONFIG as any,
    createApi: vi.fn(() => makeApi()),
    readCachedIndexContentFn: vi.fn(() => null) as any,
    writeCachedIndexContentFn: vi.fn() as any,
    runVirtualShellFn: vi.fn(() => "") as any,
    logFn: vi.fn(),
    ...extra,
  };
}

describe("codex: pure helpers", () => {
  it("buildUnsupportedGuidance names the allowed bash builtins and rejects interpreters", () => {
    const s = buildUnsupportedGuidance();
    expect(s).toMatch(/cat.*grep.*echo/);
    expect(s).toMatch(/python|node|curl/);
  });

  it("runVirtualShell returns empty string and calls logFn when the spawn fails", () => {
    const logFn = vi.fn();
    // /nope is not executable → execFileSync throws, caught by the wrapper.
    const out = runVirtualShell("cat /x", "/nope", logFn);
    expect(out).toBe("");
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("virtual shell failed"));
  });
});

describe("processCodexPreToolUse: pass-through + unsafe", () => {
  it("returns `pass` when the command doesn't mention the memory path", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "ls /tmp" } },
      baseDeps(),
    );
    expect(d.action).toBe("pass");
  });

  it("returns `guide` with the unsupported-command guidance when a memory-path command uses an interpreter", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "python ~/.deeplake/memory/x.py" } },
      baseDeps(),
    );
    expect(d.action).toBe("guide");
    expect(d.output).toContain("not supported");
    expect(d.rewrittenCommand).toContain("python");
  });

  it("falls back to runVirtualShell when no config is loaded", async () => {
    const runVirtualShellFn = vi.fn(() => "FROM-SHELL") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md" } },
      { ...baseDeps({ runVirtualShellFn }), config: null as any },
    );
    expect(d.action).toBe("block");
    expect(d.output).toBe("FROM-SHELL");
    expect(runVirtualShellFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the virtual shell's empty-result placeholder when the shell returns empty", async () => {
    const runVirtualShellFn = vi.fn(() => "") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/nonexistent.md" } },
      {
        ...baseDeps({ runVirtualShellFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toContain("Command returned empty or the file does not exist");
  });
});

describe("processCodexPreToolUse: compiled bash fast-path", () => {
  it("delegates to executeCompiledBashCommand and blocks with its output when a segment compiles", async () => {
    const executeCompiledBashCommandFn = vi.fn(async () => "COMPILED OUTPUT") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md && ls ~/.deeplake/memory/summaries" } },
      { ...baseDeps(), executeCompiledBashCommandFn },
    );
    expect(d.action).toBe("block");
    expect(d.output).toBe("COMPILED OUTPUT");
    expect(executeCompiledBashCommandFn).toHaveBeenCalled();
  });

  it("the compiled fallback callback cache-hits /index.md without re-querying the sessions table", async () => {
    const readCachedIndexContentFn = vi.fn(() => "CACHED INDEX");
    const readVirtualPathContentsFn = vi.fn(async (_api, _m, _s, paths: string[]) =>
      new Map<string, string | null>(paths.map((p) => [p, `FETCHED:${p}`])),
    ) as any;
    // Bash compiler asks for both /index.md and /sessions/x.json; only
    // /sessions/x.json must reach the SQL layer.
    const executeCompiledBashCommandFn = vi.fn(async (_api, _m, _s, _cmd, deps) => {
      const fetched = await deps.readVirtualPathContentsFn(_api, _m, _s, ["/index.md", "/sessions/x.json"]);
      return `idx=${fetched.get("/index.md")};x=${fetched.get("/sessions/x.json")}`;
    }) as any;

    const d = await processCodexPreToolUse(
      { session_id: "sess-A", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md && cat ~/.deeplake/memory/sessions/x.json" } },
      {
        ...baseDeps({ readCachedIndexContentFn, readVirtualPathContentsFn }),
        executeCompiledBashCommandFn,
      },
    );
    expect(d.output).toContain("idx=CACHED INDEX");
    expect(d.output).toContain("x=FETCHED:/sessions/x.json");
    // Cache read was issued; the SQL read only fetched the non-cached path.
    expect(readCachedIndexContentFn).toHaveBeenCalledWith("sess-A");
    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      ["/sessions/x.json"],
    );
  });
});

describe("processCodexPreToolUse: direct read (cat/head/tail/wc)", () => {
  it("cat <file> returns raw content", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "line1\nline2\nline3") as any,
      },
    );
    expect(d.output).toBe("line1\nline2\nline3");
  });

  it("head -N <file> slices to the first N lines", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "head -2 ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "l1\nl2\nl3\nl4") as any,
      },
    );
    expect(d.output).toBe("l1\nl2");
  });

  it("head <file> (no -N) defaults to 10 lines", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "head ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe(Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n"));
  });

  it("tail -N <file> slices to the last N lines", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "tail -2 ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "l1\nl2\nl3\nl4") as any,
      },
    );
    expect(d.output).toBe("l3\nl4");
  });

  it("tail <file> defaults to the last 10 lines", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "tail ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe(Array.from({ length: 10 }, (_, i) => `L${i + 10}`).join("\n"));
  });

  it("wc -l <file> returns `<count> <virtualPath>`", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "wc -l ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "a\nb\nc") as any,
      },
    );
    expect(d.output).toBe("3 /sessions/a.json");
  });

  it("cat | head pipeline collapses to a single head read", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json | head -3" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe("L0\nL1\nL2");
  });
});

describe("processCodexPreToolUse: /index.md caching + fallback", () => {
  it("serves /index.md from the session cache when present — no virtual-path fetch", async () => {
    const readCachedIndexContentFn = vi.fn(() => "CACHED-BODY");
    const readVirtualPathContentFn = vi.fn(async () => "FRESH") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s-cache", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md" } },
      {
        ...baseDeps({ readCachedIndexContentFn, readVirtualPathContentFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("CACHED-BODY");
    expect(readVirtualPathContentFn).not.toHaveBeenCalled();
  });

  it("on cache miss fetches /index.md via readVirtualPathContent + writes it into the cache", async () => {
    const writeCachedIndexContentFn = vi.fn();
    const d = await processCodexPreToolUse(
      { session_id: "s-miss", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md" } },
      {
        ...baseDeps({ writeCachedIndexContentFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "FRESH INDEX") as any,
      },
    );
    expect(d.output).toBe("FRESH INDEX");
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s-miss", "FRESH INDEX");
  });

  it("falls back to the inline memory-table SELECT when readVirtualPathContent returns null for /index.md", async () => {
    // Simulates a table where memory has rows but the path isn't in the
    // exact-path union. Codex's fallback builder queries /summaries/%.
    const api = makeApi([
      { path: "/summaries/a/s1.md", project: "proj", description: "desc", creation_date: "2026-04-20" },
      { path: "/summaries/a/s2.md", project: "", description: "", creation_date: "2026-04-19" },
    ]);
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/index.md" } },
      {
        ...baseDeps({ createApi: vi.fn(() => api) }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toContain("# Memory Index");
    expect(d.output).toContain("2 sessions:");
    expect(d.output).toContain("/summaries/a/s1.md");
    expect(d.output).toContain("[proj]");
  });
});

describe("processCodexPreToolUse: ls branch", () => {
  it("short-format listing renders file vs dir entries + empty-name rows are skipped", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/summaries/top.md", size_bytes: 10 },       // file directly under /summaries
      { path: "/summaries/alice/s1.md", size_bytes: 42 },  // nested → alice becomes a dir
      { path: "/summaries/", size_bytes: 0 },               // trailing slash — skipped
    ]) as any;

    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "ls ~/.deeplake/memory/summaries" } },
      {
        ...baseDeps({ listVirtualPathRowsFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toContain("top.md");
    expect(d.output).toContain("alice/");
    expect(d.output!.split("\n").filter(l => l).length).toBe(2);
  });

  it("long-format listing includes permission strings and sizes", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "ls -la ~/.deeplake/memory/summaries" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        listVirtualPathRowsFn: vi.fn(async () => [
          { path: "/summaries/top.md", size_bytes: 42 },
          { path: "/summaries/alice/s1.md", size_bytes: 100 },
        ]) as any,
      },
    );
    expect(d.output).toContain("-rw-r--r--");
    expect(d.output).toContain("top.md");
    expect(d.output).toContain("drwxr-xr-x");
    expect(d.output).toContain("alice/");
  });

  it("ls on an empty or non-existent directory returns a 'cannot access' message", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "ls ~/.deeplake/memory/nope" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        listVirtualPathRowsFn: vi.fn(async () => []) as any,
      },
    );
    expect(d.output).toContain("cannot access");
    expect(d.output).toContain("No such file or directory");
  });
});

describe("processCodexPreToolUse: find + grep + fallback", () => {
  it("find <dir> -name '<pat>' returns matching paths joined with newlines", async () => {
    const findVirtualPathsFn = vi.fn(async () => [
      "/sessions/conv_0_session_1.json",
      "/sessions/conv_0_session_2.json",
    ]) as any;

    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "find ~/.deeplake/memory/sessions -name '*.json'" } },
      {
        ...baseDeps({ findVirtualPathsFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("/sessions/conv_0_session_1.json\n/sessions/conv_0_session_2.json");
  });

  it("find … | wc -l collapses to the count", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "find ~/.deeplake/memory/sessions -name '*.json' | wc -l" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        findVirtualPathsFn: vi.fn(async () => ["/a", "/b", "/c"]) as any,
      },
    );
    expect(d.output).toBe("3");
  });

  it("find with zero matches returns '(no matches)'", async () => {
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "find ~/.deeplake/memory/sessions -name '*.xyz'" } },
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        findVirtualPathsFn: vi.fn(async () => []) as any,
      },
    );
    expect(d.output).toBe("(no matches)");
  });

  it("grep via parseBashGrep delegates to handleGrepDirect", async () => {
    const handleGrepDirectFn = vi.fn(async () => "/sessions/a.json:matching line") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "grep -l foo ~/.deeplake/memory/sessions/*.json" } },
      {
        ...baseDeps({ handleGrepDirectFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("/sessions/a.json:matching line");
    expect(handleGrepDirectFn).toHaveBeenCalled();
  });

  it("falls back to runVirtualShell when the direct-query path throws mid-flow", async () => {
    const runVirtualShellFn = vi.fn(() => "SHELL OK") as any;
    const d = await processCodexPreToolUse(
      { session_id: "s", tool_name: "shell", tool_input: { command: "cat ~/.deeplake/memory/sessions/a.json" } },
      {
        ...baseDeps({ runVirtualShellFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => { throw new Error("network bonk"); }) as any,
      },
    );
    expect(d.output).toBe("SHELL OK");
    expect(runVirtualShellFn).toHaveBeenCalled();
  });
});
