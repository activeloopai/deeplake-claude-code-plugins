import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Credentials } from "../../src/commands/auth.js";
import {
  buildCaptureEntry,
  maybeTriggerPeriodicSummary,
  runCaptureHook,
} from "../../src/hooks/capture.js";
import {
  extractGrepParams,
  getShellCommand,
  isSafe,
  processPreToolUse,
  rewritePaths,
  touchesMemory,
} from "../../src/hooks/pre-tool-use.js";
import {
  buildSessionStartAdditionalContext,
  runSessionStartHook,
} from "../../src/hooks/session-start.js";
import {
  createPlaceholder,
  runSessionStartSetup,
} from "../../src/hooks/session-start-setup.js";
import { runSessionEndHook } from "../../src/hooks/session-end.js";
import { isDirectRun } from "../../src/utils/direct-run.js";

const baseConfig: Config = {
  token: "token",
  orgId: "org-1",
  orgName: "Acme",
  userName: "alice",
  workspaceId: "default",
  apiUrl: "https://api.example.com",
  tableName: "memory",
  sessionsTableName: "sessions",
  graphNodesTableName: "graph_nodes",
  graphEdgesTableName: "graph_edges",
  factsTableName: "memory_facts",
  entitiesTableName: "memory_entities",
  factEntityLinksTableName: "fact_entity_links",
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

let originalArgv1: string | undefined;

beforeEach(() => {
  originalArgv1 = process.argv[1];
});

afterEach(() => {
  if (originalArgv1 === undefined) delete process.argv[1];
  else process.argv[1] = originalArgv1;
  vi.restoreAllMocks();
});

describe("direct-run", () => {
  it("returns true when the current entry matches the module path", () => {
    process.argv[1] = "/tmp/hook.js";
    expect(isDirectRun("file:///tmp/hook.js")).toBe(true);
  });

  it("returns false when the current entry differs", () => {
    process.argv[1] = "/tmp/other.js";
    expect(isDirectRun("file:///tmp/hook.js")).toBe(false);
  });

  it("returns false when there is no entry script", () => {
    delete process.argv[1];
    expect(isDirectRun("file:///tmp/hook.js")).toBe(false);
  });

  it("returns false when the meta url cannot be converted to a file path", () => {
    process.argv[1] = "/tmp/hook.js";
    expect(isDirectRun("not-a-valid-file-url")).toBe(false);
  });
});

describe("claude capture source", () => {
  it("builds user, tool, and assistant entries", () => {
    const user = buildCaptureEntry({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    }, "2026-01-01T00:00:00.000Z");
    const tool = buildCaptureEntry({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/a.ts" },
      tool_response: { content: "ok" },
      tool_use_id: "tu-1",
    }, "2026-01-01T00:00:01.000Z");
    const assistant = buildCaptureEntry({
      session_id: "s1",
      hook_event_name: "Stop",
      last_assistant_message: "done",
      agent_transcript_path: "/tmp/agent.jsonl",
    }, "2026-01-01T00:00:02.000Z");

    expect(user?.type).toBe("user_message");
    expect(user?.content).toBe("hello");
    expect(tool?.type).toBe("tool_call");
    expect(tool?.tool_name).toBe("Read");
    expect(JSON.parse(tool?.tool_input as string)).toEqual({ file_path: "/tmp/a.ts" });
    expect(assistant?.type).toBe("assistant_message");
    expect(assistant?.agent_transcript_path).toBe("/tmp/agent.jsonl");
    expect(buildCaptureEntry({ session_id: "s1" }, "2026-01-01T00:00:00.000Z")).toBeNull();
  });

  it("triggers periodic summaries only when the threshold is met and the lock is acquired", () => {
    const bump = vi.fn(() => ({ totalCount: 10, lastSummaryCount: 4 }));
    const load = vi.fn(() => ({ everyNMessages: 5, everyHours: 24 }));
    const should = vi.fn(() => true);
    const lock = vi.fn(() => true);
    const spawn = vi.fn();
    const wiki = vi.fn();

    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: bump as any,
      loadTriggerConfigFn: load as any,
      shouldTriggerFn: should as any,
      tryAcquireLockFn: lock as any,
      spawnWikiWorkerFn: spawn as any,
      wikiLogFn: wiki as any,
      bundleDir: "/tmp/bundle",
    });

    expect(spawn).toHaveBeenCalledWith({
      config: baseConfig,
      sessionId: "s1",
      cwd: "/repo",
      bundleDir: "/tmp/bundle",
      reason: "Periodic",
    });
    expect(wiki).toHaveBeenCalled();
  });

  it("suppresses periodic summaries when the lock is held", () => {
    const spawn = vi.fn();
    const logFn = vi.fn();

    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => ({ totalCount: 10, lastSummaryCount: 4 })) as any,
      loadTriggerConfigFn: vi.fn(() => ({ everyNMessages: 5, everyHours: 24 })) as any,
      shouldTriggerFn: vi.fn(() => true) as any,
      tryAcquireLockFn: vi.fn(() => false) as any,
      spawnWikiWorkerFn: spawn as any,
      logFn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("lock held"));
  });

  it("returns disabled, no_config, ignored, queued, and flushed states", async () => {
    expect(await runCaptureHook({ session_id: "s1", prompt: "hi" }, {
      captureEnabled: false,
      config: baseConfig,
    })).toEqual({ status: "disabled" });

    expect(await runCaptureHook({ session_id: "s1", prompt: "hi" }, {
      config: null,
    })).toEqual({ status: "no_config" });

    expect(await runCaptureHook({ session_id: "s1" }, {
      config: baseConfig,
    })).toEqual({ status: "ignored" });

    const append = vi.fn();
    const maybe = vi.fn();
    const clear = vi.fn();
    const queued = await runCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
    }, {
      config: baseConfig,
      now: () => "2026-01-01T00:00:00.000Z",
      appendQueuedSessionRowFn: append as any,
      clearSessionQueryCacheFn: clear as any,
      maybeTriggerPeriodicSummaryFn: maybe as any,
    });
    expect(queued.status).toBe("queued");
    expect(append).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith("s1");
    expect(maybe).toHaveBeenCalledWith("s1", "/repo", baseConfig);

    const flush = vi.fn(async () => ({ status: "flushed", rows: 2, batches: 1 }));
    const flushed = await runCaptureHook({
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }, {
      config: baseConfig,
      now: () => "2026-01-01T00:00:01.000Z",
      appendQueuedSessionRowFn: vi.fn() as any,
      flushSessionQueueFn: flush as any,
    });
    expect(flushed).toMatchObject({ status: "queued", flushStatus: "flushed" });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("suppresses periodic summaries when skipped or when the helper throws", () => {
    const spawn = vi.fn();
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      wikiWorker: true,
      spawnWikiWorkerFn: spawn as any,
    });
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => { throw new Error("boom"); }) as any,
      spawnWikiWorkerFn: spawn as any,
      logFn: vi.fn(),
    });
    maybeTriggerPeriodicSummary("s1", "/repo", baseConfig, {
      bumpTotalCountFn: vi.fn(() => ({ totalCount: 1, lastSummaryCount: 1 })) as any,
      loadTriggerConfigFn: vi.fn(() => ({ everyNMessages: 5, everyHours: 24 })) as any,
      shouldTriggerFn: vi.fn(() => false) as any,
      spawnWikiWorkerFn: spawn as any,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("queues assistant events with fallback project and description metadata", async () => {
    const append = vi.fn();
    const build = vi.fn((row) => row);
    const result = await runCaptureHook({
      session_id: "s1",
      last_assistant_message: "done",
    }, {
      config: baseConfig,
      appendQueuedSessionRowFn: append as any,
      buildQueuedSessionRowFn: build as any,
      maybeTriggerPeriodicSummaryFn: vi.fn() as any,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.status).toBe("queued");
    expect(build).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "unknown",
      description: "",
    }));
  });
});

describe("claude pre-tool source", () => {
  it("detects, rewrites, and validates memory commands", () => {
    expect(touchesMemory("cat ~/.deeplake/memory/index.md")).toBe(true);
    expect(rewritePaths("cat ~/.deeplake/memory/index.md")).toBe("cat /index.md");
    expect(isSafe("cat /index.md | head -20")).toBe(true);
    expect(isSafe("find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10")).toBe(true);
    expect(isSafe("for file in /sessions/conv_0_session_*.json; do echo \"=== $(basename $file) ===\"; grep -i \"age\\|birthday\\|born\" \"$file\" 2>/dev/null | head -3; done | grep -B 1 -i \"age\\|birthday\\|born\"")).toBe(false);
    expect(isSafe("python3 -c 'print(1)' /index.md")).toBe(false);
  });

  it("builds shell commands and grep params for supported tools", () => {
    expect(getShellCommand("Read", { file_path: "~/.deeplake/memory/index.md" })).toBe("cat /index.md");
    expect(getShellCommand("Read", { path: "~/.deeplake/memory" })).toBe("ls /");
    expect(getShellCommand("Glob", { path: "~/.deeplake/memory/summaries" })).toBe("ls /");
    expect(getShellCommand("Bash", { command: "cat ~/.deeplake/memory/index.md" })).toBe("cat /index.md");
    expect(getShellCommand("Bash", { command: "python3 ~/.deeplake/memory/index.md" })).toBeNull();

    const grep = extractGrepParams("Grep", {
      pattern: "needle",
      path: "~/.deeplake/memory/index.md",
      output_mode: "count",
      "-i": true,
      "-n": true,
    }, "grep -r needle /");
    expect(grep).toMatchObject({
      pattern: "needle",
      targetPath: "/index.md",
      ignoreCase: true,
      countOnly: true,
      lineNumber: true,
    });
  });

  it("passes through psql bash commands when sql mode is enabled", () => {
    const prev = process.env.HIVEMIND_PSQL_MODE;
    process.env.HIVEMIND_PSQL_MODE = "1";
    try {
      expect(getShellCommand("Bash", {
        command: "psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 1\"",
      })).toBe("psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 1\"");
      expect(getShellCommand("Bash", {
        command: "psql -At -F '|' -c \"SELECT path, summary FROM hivemind.memory LIMIT 1\"",
      })).toBe("psql -At -F '|' -c \"SELECT path, summary FROM hivemind.memory LIMIT 1\"");
      expect(getShellCommand("Bash", {
        command: "psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions LIMIT 1\"",
      })).toBe("psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions LIMIT 1\"");
      expect(getShellCommand("Read", { file_path: "~/.deeplake/memory/index.md" })).toBeNull();
      expect(getShellCommand("Glob", { path: "~/.deeplake/memory/summaries" })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prev;
    }
  });

  it("passes through memory/session psql queries and leaves unrelated psql untouched", async () => {
    const prev = process.env.HIVEMIND_PSQL_MODE;
    process.env.HIVEMIND_PSQL_MODE = "1";
    try {
      const decision = await processPreToolUse({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command: "psql -At -F '|' -c \"SELECT path, summary FROM memory LIMIT 1\"",
        },
        tool_use_id: "tu-psql-memory",
      }, {
        config: baseConfig,
        executeCompiledBashCommandFn: vi.fn(async () => "/summaries/locomo/conv_0_session_1_summary.md|summary") as any,
      });
      expect(decision?.command).toContain("summary");

      const passthrough = await processPreToolUse({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command: "psql -At -F '|' -c \"SELECT * FROM users LIMIT 1\"",
        },
        tool_use_id: "tu-psql-pass",
      }, {
        config: baseConfig,
      });
      expect(passthrough).toBeNull();

      const sessionsQuery = await processPreToolUse({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command: "psql -At -F '|' -c \"SELECT path, creation_date, turn_index, speaker, text FROM sessions WHERE text ILIKE '%camp%' LIMIT 1\"",
        },
        tool_use_id: "tu-psql-sessions-text",
      }, {
        config: baseConfig,
        executeCompiledBashCommandFn: vi.fn(async () => "/sessions/conv_0_session_8.json|2023-08-10|1|Melanie|We planned a camping trip") as any,
      });
      expect(sessionsQuery?.command).toContain("camping trip");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prev;
    }
  });

  it("blocks virtual memory filesystem paths in facts-and-sessions-only sql mode", async () => {
    const prevPsql = process.env.HIVEMIND_PSQL_MODE;
    const prevFactsSessions = process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;
    process.env.HIVEMIND_PSQL_MODE = "1";
    process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = "1";
    try {
      expect(getShellCommand("Read", { file_path: "/index.md" })).toBeNull();
      expect(getShellCommand("Grep", { path: "/summaries/locomo", pattern: "Caroline" })).toBeNull();
      expect(getShellCommand("Bash", { command: "cat /sessions/conv_0_session_1.json" })).toBeNull();

      const guidance = await processPreToolUse({
        session_id: "s1",
        tool_name: "Read",
        tool_input: { file_path: "/index.md" },
        tool_use_id: "tu-facts-sessions-only-read",
      }, {
        config: baseConfig,
      });
      expect(guidance?.command).toContain("RETRY REQUIRED");
      expect(guidance?.command).toContain("sessions, memory_facts, memory_entities, and fact_entity_links");
      expect(guidance?.description).toContain("unsupported command");

      const bashGuidance = await processPreToolUse({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "cat /sessions/conv_0_session_1.json" },
        tool_use_id: "tu-facts-sessions-only-bash",
      }, {
        config: baseConfig,
      });
      expect(bashGuidance?.command).toContain("RETRY REQUIRED");
      expect(bashGuidance?.description).toContain("unsupported command");
    } finally {
      if (prevPsql === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prevPsql;
      if (prevFactsSessions === undefined) delete process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;
      else process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = prevFactsSessions;
    }
  });

  it("returns guidance for unsupported memory commands and passthrough for non-memory commands", async () => {
    const guidance = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "python3 -c 'print(1)' ~/.deeplake/memory" },
      tool_use_id: "tu-1",
    }, {
      config: baseConfig,
    });
    expect(guidance?.command).toContain("RETRY REQUIRED");

    const passthrough = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls -la /tmp" },
      tool_use_id: "tu-2",
    }, {
      config: baseConfig,
    });
    expect(passthrough).toBeNull();
  });

  it("keeps benchmark-style find -exec grep pipelines on the compiled path and rejects shell-loop variants", async () => {
    const compiled = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: {
        command: "find ~/.deeplake/memory/sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10",
      },
      tool_use_id: "tu-bm-1",
    }, {
      config: baseConfig,
      executeCompiledBashCommandFn: vi.fn(async (_api, _table, _sessions, cmd) => {
        expect(cmd).toBe("find /sessions -name '*.json' -exec grep -l 'Melanie' {} \\; 2>/dev/null | head -10");
        return "/sessions/conv_0_session_2.json";
      }) as any,
    });
    expect(compiled?.command).toContain("/sessions/conv_0_session_2.json");
    expect(compiled?.description).toContain("DeepLake compiled");

    const guidance = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: {
        command: "for file in ~/.deeplake/memory/sessions/conv_0_session_*.json; do echo \"=== $(basename $file) ===\"; grep -i \"age\\|birthday\\|born\" \"$file\" 2>/dev/null | head -3; done | grep -B 1 -i \"age\\|birthday\\|born\"",
      },
      tool_use_id: "tu-bm-2",
    }, {
      config: baseConfig,
    });
    expect(guidance?.command).toContain("RETRY REQUIRED");
    expect(guidance?.description).toContain("unsupported command");
  });

  it("uses direct grep, direct reads, listings, finds, and shell fallback", async () => {
    const grepDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Grep",
      tool_input: {
        pattern: "needle",
        path: "~/.deeplake/memory/index.md",
        output_mode: "files_with_matches",
      },
      tool_use_id: "tu-1",
    }, {
      config: baseConfig,
      handleGrepDirectFn: vi.fn(async () => "/index.md:needle") as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(grepDecision?.command).toContain("/index.md:needle");

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
    const readDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "~/.deeplake/memory/index.md" },
      tool_use_id: "tu-2",
    }, {
      config: baseConfig,
      createApi: vi.fn(() => api as any),
      readVirtualPathContentFn: vi.fn(async () => null) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(readDecision?.command).toContain("# Memory Index");

    const readDirDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { path: "~/.deeplake/memory" },
      tool_use_id: "tu-2b",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/summaries/alice/s1.md", size_bytes: 42 },
      ]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(readDirDecision?.command).toContain("summaries/");

    const lsDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls -la ~/.deeplake/memory/summaries" },
      tool_use_id: "tu-3",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/summaries/alice/s1.md", size_bytes: 42 },
      ]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(lsDecision?.command).toContain("drwxr-xr-x");
    expect(lsDecision?.command).toContain("alice/");

    const findDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "find ~/.deeplake/memory/summaries -name '*.md'" },
      tool_use_id: "tu-4",
    }, {
      config: baseConfig,
      findVirtualPathsFn: vi.fn(async () => ["/summaries/alice/s1.md"]) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(findDecision?.command).toContain("/summaries/alice/s1.md");

    const fallback = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "echo hi > ~/.deeplake/memory/test.md" },
      tool_use_id: "tu-5",
    }, {
      config: null,
      shellBundle: "/tmp/deeplake-shell.js",
    });
    expect(fallback?.command).toContain('node "/tmp/deeplake-shell.js"');
  });

  it("reuses cached /index.md content for direct and compiled reads within a session", async () => {
    const readVirtualPathContentFn = vi.fn(async () => "fresh index");
    const readVirtualPathContentsFn = vi.fn(async (_api, _memory, _sessions, paths: string[]) => new Map(
      paths.map((path) => [path, path === "/index.md" ? "fresh index" : null]),
    )) as any;
    const readCachedIndexContentFn = vi.fn(() => "cached index");
    const writeCachedIndexContentFn = vi.fn();

    const directDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "~/.deeplake/memory/index.md" },
      tool_use_id: "tu-cache-1",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: readCachedIndexContentFn as any,
      writeCachedIndexContentFn: writeCachedIndexContentFn as any,
      readVirtualPathContentFn: readVirtualPathContentFn as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(directDecision?.command).toContain("cached index");
    expect(readVirtualPathContentFn).not.toHaveBeenCalled();
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s1", "cached index");

    const compiledDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "cat ~/.deeplake/memory/index.md && ls ~/.deeplake/memory/summaries" },
      tool_use_id: "tu-cache-2",
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
    expect(compiledDecision?.command).toContain("cached index");
    expect(readVirtualPathContentsFn).not.toHaveBeenCalled();
  });

  it("supports head, tail, wc -l, empty directories, and shell fallback after direct-query errors", async () => {
    const contentReader = vi.fn(async () => "line1\nline2\nline3");

    const headDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "head -2 ~/.deeplake/memory/index.md" },
      tool_use_id: "tu-6",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: vi.fn(() => null) as any,
      writeCachedIndexContentFn: vi.fn() as any,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(headDecision?.command).toContain("line1\\nline2");

    const tailDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "tail -2 ~/.deeplake/memory/index.md" },
      tool_use_id: "tu-7",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: vi.fn(() => null) as any,
      writeCachedIndexContentFn: vi.fn() as any,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(tailDecision?.command).toContain("line2\\nline3");

    const wcDecision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "wc -l ~/.deeplake/memory/index.md" },
      tool_use_id: "tu-8",
    }, {
      config: baseConfig,
      readCachedIndexContentFn: vi.fn(() => null) as any,
      writeCachedIndexContentFn: vi.fn() as any,
      readVirtualPathContentFn: contentReader as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(wcDecision?.command).toContain("3 /index.md");

    const emptyDir = await processPreToolUse({
      session_id: "s1",
      tool_name: "Glob",
      tool_input: { path: "~/.deeplake/memory/empty" },
      tool_use_id: "tu-9",
    }, {
      config: baseConfig,
      listVirtualPathRowsFn: vi.fn(async () => []) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(emptyDir?.command).toContain("(empty directory)");

    const fallback = await processPreToolUse({
      session_id: "s1",
      tool_name: "Grep",
      tool_input: {
        pattern: "needle",
        path: "~/.deeplake/memory/index.md",
      },
      tool_use_id: "tu-10",
    }, {
      config: baseConfig,
      handleGrepDirectFn: vi.fn(async () => { throw new Error("boom"); }) as any,
      shellBundle: "/tmp/deeplake-shell.js",
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    });
    expect(fallback?.description).toContain("DeepLake shell");
  });

  it("returns compiled output when the bash compiler can satisfy the command directly", async () => {
    const decision = await processPreToolUse({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "cat ~/.deeplake/memory/index.md && ls ~/.deeplake/memory/summaries" },
      tool_use_id: "tu-11",
    }, {
      config: baseConfig,
      executeCompiledBashCommandFn: vi.fn(async () => "compiled output") as any,
    });

    expect(decision?.command).toContain("compiled output");
    expect(decision?.description).toContain("DeepLake compiled");
  });

  it("routes supported psql benchmark commands through the compiled path", async () => {
    const prev = process.env.HIVEMIND_PSQL_MODE;
    process.env.HIVEMIND_PSQL_MODE = "1";
    try {
      const decision = await processPreToolUse({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command: "psql -At -F '|' -c \"SELECT path, summary FROM memory WHERE summary ILIKE '%Caroline%' LIMIT 1\"",
        },
        tool_use_id: "tu-psql-1",
      }, {
        config: baseConfig,
        executeCompiledBashCommandFn: vi.fn(async (_api, _table, _sessions, cmd) => {
          expect(cmd).toBe("psql -At -F '|' -c \"SELECT path, summary FROM memory WHERE summary ILIKE '%Caroline%' LIMIT 1\"");
          return "/summaries/locomo/conv_0_session_6_summary.md|Caroline keeps classic kids books";
        }) as any,
      });

      expect(decision?.command).toContain("classic kids books");
      expect(decision?.description).toContain("DeepLake compiled");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prev;
    }
  });
});

describe("claude session start source", () => {
  it("builds logged-in and logged-out context with update notices", () => {
    const loggedIn = buildSessionStartAdditionalContext({
      authCommand: "/tmp/auth-login.js",
      creds: baseCreds,
      currentVersion: "0.6.0",
      latestVersion: "0.6.0",
    });
    const loggedOut = buildSessionStartAdditionalContext({
      authCommand: "/tmp/auth-login.js",
      creds: null,
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
    });

    expect(loggedIn).toContain("Logged in to Deeplake");
    expect(loggedIn).toContain("Hivemind v0.6.0");
    expect(loggedIn).toContain("resolve it against that session's own date/date_time metadata");
    expect(loggedIn).toContain("convert the final answer into an absolute month/date/year");
    expect(loggedIn).toContain("answer with the smallest exact phrase supported by memory");
    expect(loggedIn).toContain('Do NOT answer "not found"');
    expect(loggedOut).toContain("Not logged in to Deeplake");
    expect(loggedOut).toContain("update available");
  });

  it("skips in wiki-worker mode and backfills usernames when needed", async () => {
    expect(await runSessionStartHook({}, { wikiWorker: true })).toBeNull();

    const save = vi.fn();
    const result = await runSessionStartHook({}, {
      creds: { ...baseCreds, userName: undefined },
      saveCredentialsFn: save as any,
      currentVersion: "0.6.0",
      latestVersion: "0.6.0",
      authCommand: "/tmp/auth-login.js",
    });

    expect(result?.hookSpecificOutput.additionalContext).toContain("Logged in to Deeplake");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("logs unauthenticated startup and still returns context", async () => {
    const logFn = vi.fn();
    const result = await runSessionStartHook({}, {
      creds: null,
      currentVersion: null,
      latestVersion: null,
      authCommand: "/tmp/auth-login.js",
      logFn,
    });

    expect(result?.hookSpecificOutput.additionalContext).toContain("Not logged in to Deeplake");
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("no credentials"));
  });

  it("falls back to org id and default workspace when names are missing", () => {
    const context = buildSessionStartAdditionalContext({
      authCommand: "/tmp/auth-login.js",
      creds: { ...baseCreds, orgName: undefined, workspaceId: undefined } as any,
      currentVersion: null,
      latestVersion: null,
    });
    expect(context).toContain("org-1");
    expect(context).toContain("workspace: default");
    expect(context).not.toContain("Hivemind v");
  });

  it("switches to sessions-only guidance when the env flag is set", () => {
    const prev = process.env.HIVEMIND_SESSIONS_ONLY;
    process.env.HIVEMIND_SESSIONS_ONLY = "1";
    try {
      const context = buildSessionStartAdditionalContext({
        authCommand: "/tmp/auth-login.js",
        creds: baseCreds,
        currentVersion: null,
        latestVersion: null,
      });
      expect(context).toContain("SESSIONS-ONLY mode");
      expect(context).toContain("do NOT start with index.md or summaries");
      expect(context).not.toContain("Always read index.md first");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_SESSIONS_ONLY;
      else process.env.HIVEMIND_SESSIONS_ONLY = prev;
    }
  });

  it("switches to sql guidance when psql mode is enabled", () => {
    const prev = process.env.HIVEMIND_PSQL_MODE;
    process.env.HIVEMIND_PSQL_MODE = "1";
    try {
      const context = buildSessionStartAdditionalContext({
        authCommand: "/tmp/auth-login.js",
        creds: baseCreds,
        currentVersion: null,
        latestVersion: null,
      });
      expect(context).toContain("DEEPLAKE MEMORY SQL MODE");
      expect(context).toContain("memory(path, summary");
      expect(context).toContain("sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)");
      expect(context).toContain("memory_facts(path, fact_id, subject_entity_id");
      expect(context).toContain("memory_entities(path, entity_id, canonical_name");
      expect(context).toContain("fact_entity_links(path, link_id, fact_id");
      expect(context).toContain("psql -At -F '|'");
      expect(context).toContain("For stable person/project/place facts, use memory_facts first.");
      expect(context).toContain("Graph-backed entity and relation resolution is applied automatically");
      expect(context).toContain("Use sessions.text, sessions.speaker, sessions.turn_index, and sessions.source_date_time");
      expect(context).toContain("Use sessions.message only when you need the raw JSON payload");
      expect(context).toContain("Do not use filesystem commands");
      expect(context).not.toContain("Always read index.md first");
      expect(context).not.toContain("~/.deeplake/memory");
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prev;
    }
  });

  it("switches to facts-and-sessions-only sql guidance when that env flag is set", () => {
    const prevPsql = process.env.HIVEMIND_PSQL_MODE;
    const prevFactsSessions = process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;
    process.env.HIVEMIND_PSQL_MODE = "1";
    process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = "1";
    try {
      const context = buildSessionStartAdditionalContext({
        authCommand: "/tmp/auth-login.js",
        creds: baseCreds,
        currentVersion: null,
        latestVersion: null,
      });
      expect(context).toContain("The summary and graph tables are intentionally unavailable in this mode.");
      expect(context).toContain("sessions(path, creation_date, turn_index, event_type, dia_id, speaker, text, turn_summary, source_date_time, message)");
      expect(context).toContain("memory_facts(path, fact_id, subject_entity_id");
      expect(context).toContain("memory_entities(path, entity_id, canonical_name");
      expect(context).toContain("fact_entity_links(path, link_id, fact_id");
      expect(context).not.toContain("memory(path, summary");
      expect(context).not.toContain("Graph-backed entity and relation resolution is applied automatically");
    } finally {
      if (prevPsql === undefined) delete process.env.HIVEMIND_PSQL_MODE;
      else process.env.HIVEMIND_PSQL_MODE = prevPsql;
      if (prevFactsSessions === undefined) delete process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY;
      else process.env.HIVEMIND_PSQL_FACTS_SESSIONS_ONLY = prevFactsSessions;
    }
  });

  it("logs authenticated startup without backfilling when the username is already present", async () => {
    const logFn = vi.fn();
    const save = vi.fn();
    await runSessionStartHook({}, {
      creds: { ...baseCreds, orgName: undefined },
      saveCredentialsFn: save as any,
      currentVersion: "0.6.0",
      latestVersion: null,
      authCommand: "/tmp/auth-login.js",
      logFn,
    });
    expect(save).not.toHaveBeenCalled();
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("org=org-1"));
  });
});

describe("claude session start setup source", () => {
  it("creates placeholders only when summaries do not already exist", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT path")) return [];
      return [];
    });
    const api = { query } as any;

    await createPlaceholder(api, "memory", "s1", "/repo", "alice", "Acme", "default");

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('INSERT INTO "memory"');
    expect(String(query.mock.calls[1]?.[0])).toContain("/summaries/alice/s1.md");
    expect(String(query.mock.calls[1]?.[0])).toContain("/sessions/alice/alice_Acme_default_s1.jsonl");

    query.mockReset();
    query.mockResolvedValueOnce([{ path: "/summaries/alice/s1.md" }]);
    await createPlaceholder(api, "memory", "s1", "/repo", "alice", "Acme", "default");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("handles no credentials, disabled session writes, auth failures, and update notices", async () => {
    expect(await runSessionStartSetup({ session_id: "s1" }, {
      creds: null,
    })).toEqual({ status: "no_credentials" });

    const createApi = vi.fn(() => ({
      ensureTable: vi.fn(async () => undefined),
      ensureSessionsTable: vi.fn(async () => undefined),
      ensureGraphNodesTable: vi.fn(async () => undefined),
      ensureGraphEdgesTable: vi.fn(async () => undefined),
      ensureFactsTable: vi.fn(async () => undefined),
      ensureEntitiesTable: vi.fn(async () => undefined),
      ensureFactEntityLinksTable: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
    }) as any);
    const placeholder = vi.fn(async () => undefined);

    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: baseCreds,
      config: baseConfig,
      createApi,
      isSessionWriteDisabledFn: vi.fn(() => true) as any,
      createPlaceholderFn: placeholder as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.7.0") as any,
      execSyncFn: vi.fn() as any,
    });
    expect(placeholder).toHaveBeenCalledTimes(1);
    expect(createApi).toHaveBeenCalledTimes(1);

    const markDisabled = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true as any);
    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: { ...baseCreds, autoupdate: false },
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => { throw new Error("403 Forbidden"); }),
        ensureGraphNodesTable: vi.fn(async () => undefined),
        ensureGraphEdgesTable: vi.fn(async () => undefined),
        ensureFactsTable: vi.fn(async () => undefined),
        ensureEntitiesTable: vi.fn(async () => undefined),
        ensureFactEntityLinksTable: vi.fn(async () => undefined),
        query: vi.fn(async () => []),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      isSessionWriteAuthErrorFn: vi.fn(() => true) as any,
      markSessionWriteDisabledFn: markDisabled as any,
      tryAcquireSessionDrainLockFn: vi.fn(() => (() => undefined)) as any,
      createPlaceholderFn: vi.fn(async () => undefined) as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.7.0") as any,
    });
    expect(markDisabled).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("update available"));
  });

  it("backfills usernames, logs drained queues, and handles setup/version failures", async () => {
    const save = vi.fn();
    const logFn = vi.fn();
    const wikiLogFn = vi.fn();
    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: { ...baseCreds, userName: undefined, autoupdate: true },
      saveCredentialsFn: save as any,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => undefined),
        ensureGraphNodesTable: vi.fn(async () => undefined),
        ensureGraphEdgesTable: vi.fn(async () => undefined),
        ensureFactsTable: vi.fn(async () => undefined),
        ensureEntitiesTable: vi.fn(async () => undefined),
        ensureFactEntityLinksTable: vi.fn(async () => undefined),
        query: vi.fn(async () => []),
      }) as any),
      drainSessionQueuesFn: vi.fn(async () => ({
        queuedSessions: 1,
        flushedSessions: 1,
        rows: 3,
        batches: 1,
      })) as any,
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      tryAcquireSessionDrainLockFn: vi.fn(() => (() => undefined)) as any,
      createPlaceholderFn: vi.fn(async () => undefined) as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.6.0") as any,
      logFn,
      wikiLogFn,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("drained 1 queued session"));
    expect(logFn).toHaveBeenCalledWith("version up to date: 0.6.0");
    expect(wikiLogFn).not.toHaveBeenCalledWith(expect.stringContaining("failed"));

    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
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

  it("skips duplicate queue drains while another session-start setup is already handling sessions", async () => {
    const logFn = vi.fn();
    const createPlaceholderFn = vi.fn(async () => undefined);
    const ensureSessionsTable = vi.fn(async () => undefined);
    const drainSessionQueuesFn = vi.fn(async () => ({
      queuedSessions: 1,
      flushedSessions: 1,
      rows: 1,
      batches: 1,
    }));

    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: baseCreds,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable,
        ensureGraphNodesTable: vi.fn(async () => undefined),
        ensureGraphEdgesTable: vi.fn(async () => undefined),
        ensureFactsTable: vi.fn(async () => undefined),
        ensureEntitiesTable: vi.fn(async () => undefined),
        ensureFactEntityLinksTable: vi.fn(async () => undefined),
        query: vi.fn(async () => []),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      tryAcquireSessionDrainLockFn: vi.fn(() => null) as any,
      drainSessionQueuesFn: drainSessionQueuesFn as any,
      createPlaceholderFn: createPlaceholderFn as any,
      getInstalledVersionFn: vi.fn(() => null) as any,
      logFn,
    });

    expect(ensureSessionsTable).not.toHaveBeenCalled();
    expect(drainSessionQueuesFn).not.toHaveBeenCalled();
    expect(createPlaceholderFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("sessions drain already in progress"));
  });

  it("handles capture-disabled, successful autoupdate, and skipped setup work", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true as any);
    const execSyncFn = vi.fn();
    const createPlaceholderFn = vi.fn();
    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: baseCreds,
      config: baseConfig,
      captureEnabled: false,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
      }) as any),
      createPlaceholderFn: createPlaceholderFn as any,
      getInstalledVersionFn: vi.fn(() => "0.6.0") as any,
      getLatestVersionCachedFn: vi.fn(async () => "0.7.0") as any,
      execSyncFn: execSyncFn as any,
    });
    expect(createPlaceholderFn).not.toHaveBeenCalled();
    expect(execSyncFn).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("auto-updated"));

    await expect(runSessionStartSetup({ session_id: "", cwd: "/repo" }, {
      creds: baseCreds,
      config: baseConfig,
      getInstalledVersionFn: vi.fn(() => null) as any,
    })).resolves.toEqual({ status: "complete" });
  });

  it("treats non-auth session setup errors as setup failures", async () => {
    const wikiLogFn = vi.fn();
    const createPlaceholderFn = vi.fn();
    await runSessionStartSetup({ session_id: "s1", cwd: "/repo" }, {
      creds: baseCreds,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => { throw new Error("boom"); }),
        ensureGraphNodesTable: vi.fn(async () => undefined),
        ensureGraphEdgesTable: vi.fn(async () => undefined),
        ensureFactsTable: vi.fn(async () => undefined),
        ensureEntitiesTable: vi.fn(async () => undefined),
        ensureFactEntityLinksTable: vi.fn(async () => undefined),
      }) as any),
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      isSessionWriteAuthErrorFn: vi.fn(() => false) as any,
      tryAcquireSessionDrainLockFn: vi.fn(() => (() => undefined)) as any,
      createPlaceholderFn: createPlaceholderFn as any,
      getInstalledVersionFn: vi.fn(() => null) as any,
      wikiLogFn,
    });
    expect(createPlaceholderFn).not.toHaveBeenCalled();
    expect(wikiLogFn).toHaveBeenCalledWith(expect.stringContaining("failed for s1: boom"));
  });

  it("skips in wiki-worker mode and handles zero-drain session writes", async () => {
    expect(await runSessionStartSetup({ session_id: "s1" }, {
      wikiWorker: true,
    })).toEqual({ status: "skipped" });

    const createPlaceholderFn = vi.fn(async () => undefined);
    await runSessionStartSetup({ session_id: "s1", cwd: undefined as any }, {
      creds: baseCreds,
      config: baseConfig,
      createApi: vi.fn(() => ({
        ensureTable: vi.fn(async () => undefined),
        ensureSessionsTable: vi.fn(async () => undefined),
        ensureGraphNodesTable: vi.fn(async () => undefined),
        ensureGraphEdgesTable: vi.fn(async () => undefined),
        ensureFactsTable: vi.fn(async () => undefined),
        ensureEntitiesTable: vi.fn(async () => undefined),
        ensureFactEntityLinksTable: vi.fn(async () => undefined),
      }) as any),
      drainSessionQueuesFn: vi.fn(async () => ({
        queuedSessions: 0,
        flushedSessions: 0,
        rows: 0,
        batches: 0,
      })) as any,
      isSessionWriteDisabledFn: vi.fn(() => false) as any,
      tryAcquireSessionDrainLockFn: vi.fn(() => (() => undefined)) as any,
      createPlaceholderFn: createPlaceholderFn as any,
      getInstalledVersionFn: vi.fn(() => null) as any,
    });
    expect(createPlaceholderFn).toHaveBeenCalledWith(expect.anything(), "memory", "s1", "", "alice", "Acme", "default");
  });
});

describe("claude session end source", () => {
  it("skips when disabled, returns no_config, and flushes when active", async () => {
    expect(await runSessionEndHook({ session_id: "s1" }, {
      captureEnabled: false,
      config: baseConfig,
    })).toEqual({ status: "skipped" });

    expect(await runSessionEndHook({ session_id: "s1" }, {
      config: null,
    })).toEqual({ status: "no_config" });

    const flush = vi.fn(async () => ({ status: "flushed", rows: 3, batches: 1 }));
    const spawn = vi.fn();
    const wiki = vi.fn();
    const result = await runSessionEndHook({ session_id: "s1", cwd: "/repo" }, {
      config: baseConfig,
      flushSessionQueueFn: flush as any,
      spawnWikiWorkerFn: spawn as any,
      wikiLogFn: wiki as any,
      bundleDir: "/tmp/bundle",
    });

    expect(result).toEqual({ status: "flushed", flushStatus: "flushed" });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({
      config: baseConfig,
      sessionId: "s1",
      cwd: "/repo",
      bundleDir: "/tmp/bundle",
      reason: "SessionEnd",
    });
    expect(wiki).toHaveBeenCalled();
  });
});
