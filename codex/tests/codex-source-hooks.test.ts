import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Credentials } from "../../src/commands/auth.js";
import {
  buildCodexCaptureEntry,
  maybeTriggerPeriodicSummary,
  runCodexCaptureHook,
} from "../../src/hooks/codex/capture.js";
import {
  buildUnsupportedGuidance,
  isSafe,
  processCodexPreToolUse,
  rewritePaths,
  touchesMemory,
} from "../../src/hooks/codex/pre-tool-use.js";
import {
  buildCodexSessionStartContext,
  runCodexSessionStartHook,
} from "../../src/hooks/codex/session-start.js";
import {
  createPlaceholder,
  runCodexSessionStartSetup,
} from "../../src/hooks/codex/session-start-setup.js";
import {
  buildCodexStopEntry,
  extractLastAssistantMessage,
  runCodexStopHook,
} from "../../src/hooks/codex/stop.js";

const baseConfig: Config = {
  token: "token",
  orgId: "org-1",
  orgName: "Acme",
  userName: "alice",
  workspaceId: "default",
  apiUrl: "https://api.example.com",
  tableName: "memory",
  sessionsTableName: "sessions",
  memoryPath: "/tmp/.deeplake/memory",
};

const baseCreds: Credentials = {
  token: "token",
  orgId: "org-1",
  orgName: "Acme",
  userName: "alice",
  workspaceId: "default",
  apiUrl: "https://api.example.com",
  savedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("codex capture source", () => {
  it("builds user/tool entries and ignores unsupported events", () => {
    const user = buildCodexCaptureEntry({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.2",
      prompt: "hello",
    }, "2026-01-01T00:00:00.000Z");
    const tool = buildCodexCaptureEntry({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      model: "gpt-5.2",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      tool_response: { stdout: "ok" },
    }, "2026-01-01T00:00:01.000Z");

    expect(user?.type).toBe("user_message");
    expect(tool?.type).toBe("tool_call");
    expect(buildCodexCaptureEntry({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, "2026-01-01T00:00:02.000Z")).toBeNull();
  });

  it("triggers periodic summaries and queues capture rows", async () => {
    const spawn = vi.fn();
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => ({ totalCount: 10, lastSummaryCount: 4 })) as any,
      loadTriggerConfigFn: vi.fn(() => ({ everyNMessages: 5, everyHours: 24 })) as any,
      shouldTriggerFn: vi.fn(() => true) as any,
      tryAcquireLockFn: vi.fn(() => true) as any,
      spawnCodexWikiWorkerFn: spawn as any,
      wikiLogFn: vi.fn() as any,
      bundleDir: "/tmp/bundle",
    });
    expect(spawn).toHaveBeenCalledTimes(1);

    const append = vi.fn();
    const clear = vi.fn();
    const queued = await runCodexCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      model: "gpt-5.2",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      tool_response: { stdout: "ok" },
    }, {
      config: baseConfig,
      appendQueuedSessionRowFn: append as any,
      clearSessionQueryCacheFn: clear as any,
    });
    expect(queued.status).toBe("queued");
    expect(append).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();

    await runCodexCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.2",
      prompt: "hi",
    }, {
      config: baseConfig,
      appendQueuedSessionRowFn: vi.fn() as any,
      clearSessionQueryCacheFn: clear as any,
    });
    expect(clear).toHaveBeenCalledWith("s1");
  });

  it("returns disabled, no_config, and ignored states", async () => {
    expect(await runCodexCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.2",
      prompt: "hi",
    }, {
      captureEnabled: false,
      config: baseConfig,
    })).toEqual({ status: "disabled" });

    expect(await runCodexCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.2",
      prompt: "hi",
    }, {
      config: null,
    })).toEqual({ status: "no_config" });

    expect(await runCodexCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Unknown",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
    })).toEqual({ status: "ignored" });
  });

  it("suppresses periodic summaries when skipped or when the helper throws", () => {
    const spawn = vi.fn();
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      wikiWorker: true,
      spawnCodexWikiWorkerFn: spawn as any,
    });
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => { throw new Error("boom"); }) as any,
      spawnCodexWikiWorkerFn: spawn as any,
      logFn: vi.fn(),
    });
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => ({ totalCount: 1, lastSummaryCount: 1 })) as any,
      loadTriggerConfigFn: vi.fn(() => ({ everyNMessages: 5, everyHours: 24 })) as any,
      shouldTriggerFn: vi.fn(() => false) as any,
      spawnCodexWikiWorkerFn: spawn as any,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("codex pre-tool source", () => {
  it("detects, rewrites, and validates memory commands", () => {
    expect(touchesMemory("cat ~/.deeplake/memory/index.md")).toBe(true);
    expect(rewritePaths("cat $HOME/.deeplake/memory/index.md")).toBe("cat /index.md");
    expect(isSafe("grep -r needle /")).toBe(true);
    expect(isSafe("node -e '1' /")).toBe(false);
    expect(isSafe("echo $(uname)")).toBe(false);
    expect(buildUnsupportedGuidance()).toContain("Do NOT use python");
  });

  it("passes through non-memory commands and guides unsafe ones", async () => {
    expect(await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls -la /tmp" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    })).toEqual({ action: "pass" });

    const guidance = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-2",
      tool_input: { command: "python3 -c 'print(1)' ~/.deeplake/memory" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
    });
    expect(guidance.action).toBe("guide");
    expect(guidance.output).toContain("Only bash builtins");
  });

  it("uses direct read, direct grep, and shell fallback", async () => {
    const api = {
      query: vi.fn(async () => [
        {
          path: "/summaries/alice/s1.md",
          project: "repo",
          description: "session summary",
          creation_date: "2026-01-01T00:00:00.000Z",
        },
      ]),
    };
    const readDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "cat ~/.deeplake/memory/index.md | head -20" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      createApi: vi.fn(() => api as any),
      readVirtualPathContentFn: vi.fn(async () => null) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(readDecision.action).toBe("block");
    expect(readDecision.output).toContain("# Memory Index");

    const grepDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-2",
      tool_input: { command: "grep -r needle ~/.deeplake/memory/" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      handleGrepDirectFn: vi.fn(async () => "/index.md:needle") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(grepDecision.output).toContain("/index.md:needle");

    const fallback = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-3",
      tool_input: { command: "echo hi > ~/.deeplake/memory/test.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: null,
      runVirtualShellFn: vi.fn(() => "ok") as any,
    });
    expect(fallback).toEqual({
      action: "block",
      output: "ok",
      rewrittenCommand: "echo hi > /test.md",
    });
  });

  it("supports head, tail, wc -l, find counts, missing ls paths, and default empty-shell output", async () => {
    const contentReader = vi.fn(async () => "line1\nline2\nline3");

    const headDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-4",
      tool_input: { command: "head -2 ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(headDecision.output).toBe("line1\nline2");

    const tailDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-5",
      tool_input: { command: "tail -2 ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(tailDecision.output).toBe("line2\nline3");

    const wcDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-6",
      tool_input: { command: "wc -l ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(wcDecision.output).toBe("3 /index.md");

    const findDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-7",
      tool_input: { command: "find ~/.deeplake/memory/summaries -name '*.md' | wc -l" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      findVirtualPathsFn: vi.fn(async () => ["/summaries/alice/s1.md", "/summaries/alice/s2.md"]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(findDecision.output).toBe("2");

    const missingLs = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-8",
      tool_input: { command: "ls ~/.deeplake/memory/missing" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => []) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(missingLs.output).toContain("No such file or directory");

    const emptyShell = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-9",
      tool_input: { command: "echo hi > ~/.deeplake/memory/test.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      runVirtualShellFn: vi.fn(() => "") as any,
    });
    expect(emptyShell.output).toContain("Command returned empty");
  });

  it("returns compiled output when the bash compiler can satisfy the command directly", async () => {
    const decision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-10",
      tool_input: { command: "cat ~/.deeplake/memory/index.md && ls ~/.deeplake/memory/summaries" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      executeCompiledBashCommandFn: vi.fn(async () => "compiled output") as any,
    });

    expect(decision).toEqual({
      action: "block",
      output: "compiled output",
      rewrittenCommand: "cat /index.md && ls /summaries",
    });
  });

  it("reuses cached /index.md content for direct and compiled reads within a session", async () => {
    const readVirtualPathContentFn = vi.fn(async () => "fresh index");
    const readVirtualPathContentsFn = vi.fn(async (_api, _memory, _sessions, paths: string[]) => new Map(
      paths.map((path) => [path, path === "/index.md" ? "fresh index" : null]),
    )) as any;
    const readCachedIndexContentFn = vi.fn(() => "cached index");
    const writeCachedIndexContentFn = vi.fn();

    const directDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-cache-1",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: readCachedIndexContentFn as any,
      writeCachedIndexContentFn: writeCachedIndexContentFn as any,
      readVirtualPathContentFn: readVirtualPathContentFn as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(directDecision.output).toBe("cached index");
    expect(readVirtualPathContentFn).not.toHaveBeenCalled();
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s1", "cached index");

    const compiledDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-cache-2",
      tool_input: { command: "cat ~/.deeplake/memory/index.md && ls ~/.deeplake/memory/summaries" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: readCachedIndexContentFn as any,
      writeCachedIndexContentFn: writeCachedIndexContentFn as any,
      readVirtualPathContentsFn,
      executeCompiledBashCommandFn: vi.fn(async (_api, _table, _sessions, _cmd, deps) => {
        const map = await deps.readVirtualPathContentsFn(_api, _table, _sessions, ["/index.md"]);
        return map.get("/index.md") ?? null;
      }) as any,
    });
    expect(compiledDecision.output).toBe("cached index");
    expect(readVirtualPathContentsFn).not.toHaveBeenCalled();
  });

  it("covers plain cat, directory listings, non-count find, grep fallback, and direct-query exceptions", async () => {
    const plainCat = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-11",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: vi.fn(async () => "line1\nline2") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(plainCat).toEqual({
      action: "block",
      output: "line1\nline2",
      rewrittenCommand: "cat /index.md",
    });

    const listed = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-12",
      tool_input: { command: "ls ~/.deeplake/memory/summaries" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/other/place.md", size_bytes: 1 },
        { path: "/summaries/", size_bytes: 0 },
        { path: "/summaries/alice/s1.md", size_bytes: 10 },
        { path: "/summaries/bob/nested/file.md", size_bytes: 20 },
      ]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(listed.output).toContain("alice/");
    expect(listed.output).toContain("bob/");
    expect(listed.output).not.toContain("other");

    const rootLs = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-13",
      tool_input: { command: "ls ~/.deeplake/memory" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/", size_bytes: 0 },
        { path: "/root.md", size_bytes: 5 },
        { path: "/summaries/alice/s1.md", size_bytes: 10 },
      ]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(rootLs.output).toContain("root.md");
    expect(rootLs.output).toContain("summaries/");

    const findNoMatches = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-14",
      tool_input: { command: "find ~/.deeplake/memory/summaries -name '*.md'" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      findVirtualPathsFn: vi.fn(async () => []) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(findNoMatches.output).toBe("(no matches)");

    const findRoot = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-14b",
      tool_input: { command: "find ~/.deeplake/memory -name '*.md'" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      findVirtualPathsFn: vi.fn(async () => ["/summaries/a.md", "/notes.md"]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(findRoot.output).toContain("/summaries/a.md");
    expect(findRoot.output).toContain("/notes.md");

    const grepFallback = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-15",
      tool_input: { command: "grep needle ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      handleGrepDirectFn: vi.fn(async () => null) as any,
      runVirtualShellFn: vi.fn(() => "shell fallback") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(grepFallback.output).toBe("shell fallback");

    const errorFallback = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-16",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      executeCompiledBashCommandFn: vi.fn(async () => { throw new Error("boom"); }) as any,
      runVirtualShellFn: vi.fn(() => "fallback after error") as any,
    });
    expect(errorFallback.output).toBe("fallback after error");
  });

  it("covers default head/tail forms, synthetic index rows, and long ls formatting", async () => {
    const headDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-17",
      tool_input: { command: "head ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: vi.fn(async () => "a\nb\nc") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(headDecision.output).toBe("a\nb\nc");

    const tailDecision = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-18",
      tool_input: { command: "tail ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      readVirtualPathContentFn: vi.fn(async () => "a\nb\nc") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(tailDecision.output).toBe("a\nb\nc");

    const api = {
      query: vi.fn(async () => [{ path: "/summaries/alice/s1.md" }]),
    };
    const syntheticIndex = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-19",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      createApi: vi.fn(() => api as any),
      readVirtualPathContentFn: vi.fn(async () => null) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(syntheticIndex.output).toContain("# Memory Index");

    const longLs = await processCodexPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tu-20",
      tool_input: { command: "ls -l ~/.deeplake/memory/summaries" },
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/summaries/alice/file.md" },
        { path: "/summaries/alice/another.md", size_bytes: 3 },
        { path: "/summaries/team/nested/file.md", size_bytes: 5 },
      ]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(longLs.output).toContain("alice/");
    expect(longLs.output).toContain("team/");
    expect(longLs.output).toContain("drwxr-xr-x");
  });
});

describe("codex session start source", () => {
  it("builds logged-in and logged-out context", () => {
    const loggedIn = buildCodexSessionStartContext({
      creds: baseCreds,
      currentVersion: "0.6.0",
      authCommand: "/tmp/auth-login.js",
    });
    const loggedOut = buildCodexSessionStartContext({
      creds: null,
      currentVersion: "0.6.0",
      authCommand: "/tmp/auth-login.js",
    });

    expect(loggedIn).toContain("Logged in to Deeplake");
    expect(loggedIn).toContain("Hivemind v0.6.0");
    expect(loggedOut).toContain('Run: node "/tmp/auth-login.js" login');
  });

  it("skips in wiki-worker mode and spawns async setup when authenticated", async () => {
    expect(await runCodexSessionStartHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      wikiWorker: true,
    })).toBeNull();

    const write = vi.fn();
    const end = vi.fn();
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({
      stdin: { write, end },
      unref,
    }) as any);
    const result = await runCodexSessionStartHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: baseCreds,
      currentVersion: "0.6.0",
      spawnFn: spawnFn as any,
      setupScript: "/tmp/session-start-setup.js",
      authCommand: "/tmp/auth-login.js",
    });

    expect(result).toContain("Logged in to Deeplake");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

  it("returns logged-out context without spawning setup when unauthenticated", async () => {
    const spawnFn = vi.fn();
    const result = await runCodexSessionStartHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: null,
      spawnFn: spawnFn as any,
      currentVersion: null,
      authCommand: "/tmp/auth-login.js",
    });

    expect(result).toContain("Not logged in to Deeplake");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("falls back to org id and default workspace when names are missing", () => {
    const context = buildCodexSessionStartContext({
      creds: { ...baseCreds, orgName: undefined, workspaceId: undefined } as any,
      currentVersion: null,
      authCommand: "/tmp/auth-login.js",
    });
    expect(context).toContain("org-1");
    expect(context).toContain("workspace: default");
    expect(context).not.toContain("Hivemind v");
  });
});

describe("codex session start setup source", () => {
  it("creates placeholders only when summaries do not already exist", async () => {
    const query = vi.fn(async () => []);
    const api = { query } as any;
    await createPlaceholder(api, "memory", "s1", "/repo", "alice", "Acme", "default");
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('INSERT INTO "memory"');

    query.mockReset();
    query.mockResolvedValueOnce([{ path: "/summaries/alice/s1.md" }]);
    await createPlaceholder(api, "memory", "s1", "/repo", "alice", "Acme", "default");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("handles no credentials, disabled session writes, and update notices", async () => {
    expect(await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: null,
    })).toEqual({ status: "no_credentials" });

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true as any);
    const placeholder = vi.fn(async () => undefined);
    await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: { ...baseCreds, autoupdate: false },
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => undefined),
        query: vi.fn(async () => []),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => true) as any,
      createPlaceholderFn: placeholder as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.7.0") as any,
    });
    expect(placeholder).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("update available"));
  });

  it("skips in wiki-worker mode and logs setup/version failures", async () => {
    expect(await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      wikiWorker: true,
    })).toEqual({ status: "skipped" });

    const logFn = vi.fn();
    const wikiLogFn = vi.fn();
    await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: baseCreds,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => { throw new Error("boom"); }),
      }) as any),
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => { throw new Error("offline"); }) as any,
      logFn,
      wikiLogFn,
    });

    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("setup failed: boom"));
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("version check failed: offline"));
    expect(wikiLogFn).toHaveBeenCalledWith(expect.stringContaining("failed for s1: boom"));
  });

  it("handles capture-disabled and successful autoupdate flows", async () => {
    const placeholder = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true as any);
    const execSyncFn = vi.fn();
    await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: baseCreds,
      config: baseConfig,
      captureEnabled: false,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
      }) as any),
      createPlaceholderFn: placeholder as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.7.0") as any,
      execSyncFn: execSyncFn as any,
    });
    expect(placeholder).not.toHaveBeenCalled();
    expect(execSyncFn).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("auto-updated"));
  });

  it("handles non-auth setup errors and skips setup when session metadata is absent", async () => {
    const wikiLogFn = vi.fn();
    const createPlaceholderFn = vi.fn();
    await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: baseCreds,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => { throw new Error("boom"); }),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      isSessionWriteAuthErrorFn: vi.fn(() => false) as any,
      createPlaceholderFn: createPlaceholderFn as any,
      getInstalledVersionFn: vi.fn(() => null) as any,
      wikiLogFn,
    });
    expect(createPlaceholderFn).not.toHaveBeenCalled();
    expect(wikiLogFn).toHaveBeenCalledWith(expect.stringContaining("failed for s1: boom"));

    await expect(runCodexSessionStartSetup({
      session_id: "",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: baseCreds,
      config: baseConfig,
      getInstalledVersionFn: vi.fn(() => null) as any,
    })).resolves.toEqual({ status: "complete" });
  });

  it("backfills missing usernames, handles auth-disabled session writes, and treats missing cwd as unknown", async () => {
    const save = vi.fn();
    const placeholder = vi.fn(async () => undefined);
    await runCodexSessionStartSetup({
      session_id: "s1",
      cwd: undefined as any,
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, {
      creds: { ...baseCreds, userName: undefined },
      saveCredentialsFn: save as any,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => { throw new Error("403 Forbidden"); }),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      isSessionWriteAuthErrorFn: vi.fn(() => true) as any,
      markSessionWriteDisabledFn: vi.fn() as any,
      createPlaceholderFn: placeholder as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.6.0") as any,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(placeholder).toHaveBeenCalledWith(expect.anything(), "memory", "s1", "", "alice", "Acme", "default");

    const query = vi.fn(async () => []);
    await createPlaceholder({ query } as any, "memory", "s2", "", "alice", "Acme", "default");
    expect(String(query.mock.calls[1]?.[0])).toContain("'unknown'");
  });
});

describe("codex stop source", () => {
  it("extracts assistant messages from string and block transcripts", () => {
    expect(extractLastAssistantMessage([
      '{"role":"assistant","content":"done"}',
    ].join("\n"))).toBe("done");

    expect(extractLastAssistantMessage([
      '{"payload":{"role":"assistant","content":[{"type":"output_text","text":"first"},{"type":"text","text":"second"}]}}',
    ].join("\n"))).toBe("first\nsecond");

    expect(extractLastAssistantMessage("not json")).toBe("");
  });

  it("builds stop entries for assistant messages and assistant stops", () => {
    const message = buildCodexStopEntry({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, "2026-01-01T00:00:00.000Z", "done");
    const stop = buildCodexStopEntry({
      session_id: "s1",
      transcript_path: null,
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, "2026-01-01T00:00:01.000Z", "");

    expect(message.type).toBe("assistant_message");
    expect(stop.type).toBe("assistant_stop");
  });

  it("skips, returns no_config, and flushes plus spawns summaries", async () => {
    expect(await runCodexStopHook({
      session_id: "",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
    })).toEqual({ status: "skipped" });

    expect(await runCodexStopHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: null,
    })).toEqual({ status: "no_config" });

    const flush = vi.fn(async () => ({ status: "flushed", rows: 2, batches: 1 }));
    const spawn = vi.fn();
    const result = await runCodexStopHook({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      transcriptExists: vi.fn(() => true) as any,
      readTranscript: vi.fn(() => '{"role":"assistant","content":"done"}') as any,
      appendQueuedSessionRowFn: vi.fn() as any,
      flushSessionQueueFn: flush as any,
      spawnCodexWikiWorkerFn: spawn as any,
      wikiLogFn: vi.fn() as any,
      bundleDir: "/tmp/bundle",
    });

    expect(result).toMatchObject({ status: "complete", flushStatus: "flushed" });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({
      config: baseConfig,
      sessionId: "s1",
      cwd: "/repo",
      bundleDir: "/tmp/bundle",
      reason: "Stop",
    });

    const noCapture = await runCodexStopHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      captureEnabled: false,
    });
    expect(noCapture).toEqual({ status: "complete", entry: undefined });
  });

  it("continues when transcript reads fail and when wiki-worker mode is active", async () => {
    expect(await runCodexStopHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      wikiWorker: true,
      config: baseConfig,
    })).toEqual({ status: "skipped" });

    const flush = vi.fn(async () => ({ status: "flushed", rows: 1, batches: 1 }));
    const result = await runCodexStopHook({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      transcriptExists: vi.fn(() => true) as any,
      readTranscript: vi.fn(() => { throw new Error("boom"); }) as any,
      appendQueuedSessionRowFn: vi.fn() as any,
      flushSessionQueueFn: flush as any,
      spawnCodexWikiWorkerFn: vi.fn() as any,
      wikiLogFn: vi.fn() as any,
      bundleDir: "/tmp/bundle",
    });

    expect(result.flushStatus).toBe("flushed");
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("returns empty when assistant blocks have no text and keeps going after capture failures", async () => {
    expect(extractLastAssistantMessage([
      "{\"role\":\"assistant\",\"content\":[{\"type\":\"image\",\"url\":\"x\"}]}",
      "{\"role\":\"user\",\"content\":\"hi\"}",
    ].join("\n"))).toBe("");

    const spawn = vi.fn();
    const logFn = vi.fn();
    const result = await runCodexStopHook({
      session_id: "s1",
      transcript_path: "/tmp/missing.jsonl",
      cwd: undefined as any,
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, {
      config: baseConfig,
      transcriptExists: vi.fn(() => false) as any,
      appendQueuedSessionRowFn: vi.fn() as any,
      flushSessionQueueFn: vi.fn(async () => { throw new Error("flush boom"); }) as any,
      spawnCodexWikiWorkerFn: spawn as any,
      wikiLogFn: vi.fn() as any,
      logFn,
      bundleDir: "/tmp/bundle",
    });

    expect(result).toMatchObject({
      status: "complete",
      entry: expect.objectContaining({ type: "assistant_stop" }),
    });
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("capture failed: flush boom"));
    expect(spawn).toHaveBeenCalledWith({
      config: baseConfig,
      sessionId: "s1",
      cwd: "",
      bundleDir: "/tmp/bundle",
      reason: "Stop",
    });
  });
});
