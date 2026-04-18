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
    });
    expect(queued.status).toBe("queued");
    expect(append).toHaveBeenCalledTimes(1);
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
});

describe("codex pre-tool source", () => {
  it("detects, rewrites, and validates memory commands", () => {
    expect(touchesMemory("cat ~/.deeplake/memory/index.md")).toBe(true);
    expect(rewritePaths("cat $HOME/.deeplake/memory/index.md")).toBe("cat /index.md");
    expect(isSafe("grep -r needle /")).toBe(true);
    expect(isSafe("node -e '1' /")).toBe(false);
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
});
