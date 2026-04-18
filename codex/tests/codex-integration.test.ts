import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(__dir, "..", "bundle");

/** Pipe JSON into a bundle and return parsed stdout. */
function runHook(bundle: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}): string {
  const result = execFileSync("node", [join(bundleDir, bundle)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      ...process.env,
      // Disable capture so we don't hit the real API
      HIVEMIND_CAPTURE: "false",
      // Clear credentials to avoid API calls in tests
      HIVEMIND_TOKEN: "",
      HIVEMIND_ORG_ID: "",
      ...extraEnv,
    },
  });
  return result.trim();
}

/**
 * Run a hook that uses the block+inject strategy (exit code 2 + stderr).
 * Returns { blocked: true, stderr } for exit 2, { blocked: false, stdout } for exit 0.
 */
function runBlockHook(bundle: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}): { blocked: boolean; output: string } {
  try {
    const result = execFileSync("node", [join(bundleDir, bundle)], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        HIVEMIND_CAPTURE: "false",
        HIVEMIND_TOKEN: "",
        HIVEMIND_ORG_ID: "",
        ...extraEnv,
      },
    });
    return { blocked: false, output: result.trim() };
  } catch (e: any) {
    // Exit code 2 = blocked, stderr has the content
    if (e.status === 2) {
      return { blocked: true, output: (e.stderr || "").toString().trim() };
    }
    throw e;
  }
}

function parseOutput(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── SessionStart ─────────────────────────────────────────────────────────────
// Codex SessionStart outputs plain text (not JSON) — plain text on stdout
// is added as developer context by Codex.

describe("codex integration: session-start", () => {
  it("returns plain text with DEEPLAKE MEMORY instructions", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-001",
      transcript_path: null,
      cwd: "/tmp/test-project",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
      source: "startup",
    });

    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain("DEEPLAKE MEMORY");
    expect(raw).toContain("~/.deeplake/memory/");
    expect(raw).toContain("index.md");
    expect(raw).toContain("summaries");
    expect(raw).toContain("grep -r");
  });

  it("context includes login status", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-002",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    // Should mention login status (logged in or not)
    expect(raw).toMatch(/Logged in to Deeplake|Not logged in to Deeplake/);
  });

  it("context includes subagent warning", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-003",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    expect(raw).toContain("Do NOT spawn subagents");
  });

  it("context includes JSONL warning", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-004",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    expect(raw).toContain("Do NOT jump straight to JSONL");
  });

  it("context steers recall tasks to index-first exact file reads", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-004b",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    expect(raw).toContain("read that exact summary or session path directly");
    expect(raw).toContain("Do NOT probe unrelated local paths");
  });
});

// ── Capture (UserPromptSubmit) ───────────────────────────────────────────────

describe("codex integration: capture", () => {
  it("exits cleanly for UserPromptSubmit when capture is disabled", () => {
    const raw = runHook("capture.js", {
      session_id: "test-session-010",
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.2",
      prompt: "hello world",
    });
    // With HIVEMIND_CAPTURE=false, should produce no output and exit 0
    expect(raw).toBe("");
  });

  it("exits cleanly for PostToolUse when capture is disabled", () => {
    const raw = runHook("capture.js", {
      session_id: "test-session-011",
      cwd: "/tmp",
      hook_event_name: "PostToolUse",
      model: "gpt-5.2",
      tool_name: "Bash",
      tool_use_id: "tu-001",
      tool_input: { command: "ls -la" },
      tool_response: { stdout: "total 0" },
    });
    expect(raw).toBe("");
  });
});

// ── PreToolUse ───────────────────────────────────────────────────────────────

describe("codex integration: pre-tool-use", () => {
  it("passes through commands not targeting memory", () => {
    const raw = runHook("pre-tool-use.js", {
      session_id: "test-session-020",
      tool_name: "Bash",
      tool_use_id: "tu-010",
      tool_input: { command: "ls -la /tmp" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    // No output = pass through (don't intercept)
    expect(raw).toBe("");
  });

  it("intercepts cat targeting ~/.deeplake/memory/", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-021",
      tool_name: "Bash",
      tool_use_id: "tu-011",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    // Block+inject: exit 2 with content on stderr
    expect(blocked).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });

  it("intercepts ls targeting ~/.deeplake/memory/", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-022",
      tool_name: "Bash",
      tool_use_id: "tu-012",
      tool_input: { command: "ls ~/.deeplake/memory/" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });

  it("intercepts grep targeting ~/.deeplake/memory/", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-023",
      tool_name: "Bash",
      tool_use_id: "tu-013",
      tool_input: { command: "grep -r 'keyword' ~/.deeplake/memory/" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });

  it("returns guidance for unsafe commands targeting memory (instead of hard-blocking)", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-025",
      tool_name: "Bash",
      tool_use_id: "tu-015",
      tool_input: { command: "python3 -c 'import os; os.listdir(os.path.expanduser(\"~/.deeplake/memory\"))'" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    // Should NOT hard-block (exit 2) — instead returns guidance on stdout (exit 0)
    expect(blocked).toBe(false);
    expect(output).toContain("not supported");
    expect(output).toContain("Do NOT use python");
  });

  it("intercepts echo redirect to memory path", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-026",
      tool_name: "Bash",
      tool_use_id: "tu-016",
      tool_input: { command: "echo 'hello' > ~/.deeplake/memory/test.md" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });

  it("returns guidance for node targeting memory (not hard-block)", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-027",
      tool_name: "Bash",
      tool_use_id: "tu-017",
      tool_input: { command: "node -e 'require(\"fs\").readdirSync(\"~/.deeplake/memory\")'" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(false);
    expect(output).toContain("not supported");
  });

  it("returns guidance for curl targeting memory", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-028",
      tool_name: "Bash",
      tool_use_id: "tu-018",
      tool_input: { command: "curl -X POST https://example.com -d @~/.deeplake/memory/data.json" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(false);
    expect(output).toContain("not supported");
  });

  it("blocks deeplake mount command with guidance", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-029",
      tool_name: "Bash",
      tool_use_id: "tu-019",
      tool_input: { command: "deeplake mount ~/.deeplake/memory" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    // Deeplake CLI commands are no longer supported — should return guidance
    expect(blocked).toBe(false);
    expect(output).toContain("not supported");
  });

  it("returns guidance for command substitution $() targeting memory", () => {
    const { blocked, output } = runBlockHook("pre-tool-use.js", {
      session_id: "test-session-030",
      tool_name: "Bash",
      tool_use_id: "tu-020",
      tool_input: { command: "echo $(cat ~/.deeplake/memory/index.md)" },
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "gpt-5.2",
    });
    expect(blocked).toBe(false);
    expect(output).toContain("not supported");
  });
});

// ── SessionStartSetup ───────────────────────────────────────────────────────

describe("codex integration: session-start-setup", () => {
  it("exits cleanly when HIVEMIND_WIKI_WORKER=1", () => {
    const raw = runHook("session-start-setup.js", {
      session_id: "test-session-setup-001",
      cwd: "/tmp/test-project",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    }, { HIVEMIND_WIKI_WORKER: "1" });
    expect(raw).toBe("");
  });

  it("exits cleanly with no credentials (HIVEMIND_TOKEN='')", () => {
    const raw = runHook("session-start-setup.js", {
      session_id: "test-session-setup-002",
      cwd: "/tmp/test-project",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    expect(raw).toBe("");
  });

  it("does NOT produce stdout output (fire-and-forget)", () => {
    const raw = runHook("session-start-setup.js", {
      session_id: "test-session-setup-003",
      cwd: "/tmp/test-project",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    expect(raw).toBe("");
  });
});

// ── Stop ─────────────────────────────────────────────────────────────────────

describe("codex integration: stop", () => {
  it("exits cleanly with capture disabled and wiki worker flag", () => {
    const raw = runHook("stop.js", {
      session_id: "test-session-030",
      transcript_path: null,
      cwd: "/tmp/test-project",
      hook_event_name: "Stop",
      model: "gpt-5.2",
    }, { HIVEMIND_WIKI_WORKER: "1" });
    // With HIVEMIND_CAPTURE=false and HIVEMIND_WIKI_WORKER=1, should be silent
    expect(raw).toBe("");
  });
});
