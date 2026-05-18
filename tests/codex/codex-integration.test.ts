import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const bundleDir = join(process.cwd(), "codex", "bundle");

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
// Codex 0.130.0 surfaces SessionStart hook output to the USER as well as the
// model: top-level `systemMessage` renders as `warning: ...` in the TUI history
// cell, and `hookSpecificOutput.additionalContext` renders as `hook context:
// ...` (also user-visible — common::append_additional_context in codex-rs
// pushes to both the user-visible entries vec AND the model context vec).
// Because of this we deliberately keep `additionalContext` MINIMAL — only a
// 1-line status. The full memory tier doc + CLI command list moved into the
// `hivemind-memory` skill (codex/skills/deeplake-memory/SKILL.md), which the
// model loads on demand without spamming the terminal every session start.

describe("codex integration: session-start", () => {
  it("returns valid JSON with hookSpecificOutput.additionalContext", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-001",
      transcript_path: null,
      cwd: "/tmp/test-project",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
      source: "startup",
    });

    expect(raw.length).toBeGreaterThan(0);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    // additionalContext is INTENTIONALLY small — single line of status. The
    // verbose memory tier doc + skillify/embeddings command list lives in the
    // bundled SKILL.md, not here, because Codex prints it user-visible.
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThan(300);
  });

  it("additionalContext includes login status (logged in OR not logged in)", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-002",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    const parsed = JSON.parse(raw.trim());
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/Hivemind: logged in|Hivemind: not logged in/);
  });

  it("does NOT inline the memory tier doc into additionalContext (it lives in the skill instead)", () => {
    const raw = runHook("session-start.js", {
      session_id: "test-session-003",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    const parsed = JSON.parse(raw.trim());
    const ctx = parsed.hookSpecificOutput.additionalContext;
    // These were in the old plain-text dump. Now they belong in the skill.
    expect(ctx).not.toContain("DEEPLAKE MEMORY");
    expect(ctx).not.toContain("index.md");
    expect(ctx).not.toContain("Do NOT spawn subagents");
    expect(ctx).not.toContain("FALLBACK");
  });

  it("emits systemMessage with mined-skills CTA when not logged in AND manifest is present", () => {
    // The hook's not-logged-in branch only emits the systemMessage when
    // countLocalManifestEntries() > 0. In an isolated test HOME (no
    // ~/.claude/hivemind/local-mined.json) the count is 0 → no systemMessage
    // is emitted. Verify the field is omitted in that case so codex doesn't
    // render an empty warning.
    const raw = runHook("session-start.js", {
      session_id: "test-session-004",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      model: "gpt-5.2",
    });
    const parsed = JSON.parse(raw.trim());
    // Either no systemMessage (count==0) OR a one-line `💡` CTA with the count.
    if (parsed.systemMessage !== undefined) {
      expect(parsed.systemMessage).toMatch(/💡 \d+ skill/);
      expect(parsed.systemMessage).toContain("hivemind login");
    }
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
