import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ccRoot = join(__dir, "..");
const bundleDir = join(ccRoot, "bundle");

// ── hooks.json structure tests ──────────────────────────────────────────────

describe("claude-code hooks.json: async refactor", () => {
  const hooks = JSON.parse(readFileSync(join(ccRoot, "hooks", "hooks.json"), "utf-8"));

  it("SessionStart has exactly 2 hooks", () => {
    const sessionStart = hooks.hooks.SessionStart;
    expect(sessionStart).toHaveLength(1); // one entry
    expect(sessionStart[0].hooks).toHaveLength(2); // two hooks in the entry
  });

  it("first SessionStart hook is sync with timeout <= 15s", () => {
    const first = hooks.hooks.SessionStart[0].hooks[0];
    expect(first).not.toHaveProperty("async");
    expect(first.timeout).toBeLessThanOrEqual(15);
    expect(first.command).toContain("session-start.js");
    expect(first.command).not.toContain("session-start-setup.js");
  });

  it("second SessionStart hook is async and references session-start-setup.js", () => {
    const second = hooks.hooks.SessionStart[0].hooks[1];
    expect(second.async).toBe(true);
    expect(second.command).toContain("session-start-setup.js");
  });

  it("UserPromptSubmit has async: true", () => {
    const hook = hooks.hooks.UserPromptSubmit[0].hooks[0];
    expect(hook.async).toBe(true);
  });

  it("Stop has async: true", () => {
    const hook = hooks.hooks.Stop[0].hooks[0];
    expect(hook.async).toBe(true);
  });

  it("PreToolUse does NOT have async flag", () => {
    const hook = hooks.hooks.PreToolUse[0].hooks[0];
    expect(hook).not.toHaveProperty("async");
  });

  it("SessionEnd does NOT have async flag", () => {
    const hook = hooks.hooks.SessionEnd[0].hooks[0];
    expect(hook).not.toHaveProperty("async");
  });
});

// ── Bundle existence ────────────────────────────────────────────────────────

describe("claude-code bundle: session-start-setup.js exists", () => {
  it("session-start-setup.js exists in bundle/", () => {
    expect(existsSync(join(bundleDir, "session-start-setup.js"))).toBe(true);
    const content = readFileSync(join(bundleDir, "session-start-setup.js"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });
});

// ── getInstalledVersion: must read .claude-plugin/plugin.json ────────────────

describe("claude-code: version detection from plugin.json", () => {
  it("session-start.js reads version from .claude-plugin/plugin.json", () => {
    // This is the cache layout — no package.json with version exists,
    // only .claude-plugin/plugin.json has it. If this test fails,
    // auto-update will break for all installed users (CC v2.1.94+).
    const bundle = readFileSync(join(bundleDir, "session-start.js"), "utf-8");
    expect(bundle).toContain(".claude-plugin");
    expect(bundle).toContain("plugin.json");
  });

  it("session-start-setup.js reads version from .claude-plugin/plugin.json", () => {
    const bundle = readFileSync(join(bundleDir, "session-start-setup.js"), "utf-8");
    expect(bundle).toContain(".claude-plugin");
    expect(bundle).toContain("plugin.json");
  });

  it(".claude-plugin/plugin.json exists and has a version", () => {
    const pluginJsonPath = join(ccRoot, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(plugin.version).toBeDefined();
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── session-start.js integration tests ──────────────────────────────────────

function runHook(bundle: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}): string {
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
  return result.trim();
}

describe("claude-code integration: session-start.js (sync hook)", () => {
  const baseInput = {
    session_id: "test-session-ss-001",
    cwd: "/tmp/test-project",
    hook_event_name: "SessionStart",
  };

  it("returns valid JSON with hookSpecificOutput.additionalContext", () => {
    const raw = runHook("session-start.js", baseInput);
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("hookSpecificOutput");
    expect(parsed.hookSpecificOutput).toHaveProperty("additionalContext");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
  });

  it("additionalContext contains DEEPLAKE MEMORY", () => {
    const raw = runHook("session-start.js", baseInput);
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("DEEPLAKE MEMORY");
  });

  it("contains login status text", () => {
    const raw = runHook("session-start.js", baseInput);
    const parsed = JSON.parse(raw);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/Logged in to Deeplake|Not logged in to Deeplake/);
  });

  it("steers recall tasks toward index-first exact file reads", () => {
    const raw = runHook("session-start.js", baseInput);
    const parsed = JSON.parse(raw);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Always read index.md first");
    expect(ctx).toContain("read that exact summary or session file directly");
    expect(ctx).toContain("Do NOT probe unrelated local paths");
  });

  it("completes within 3s with no credentials (no server calls)", () => {
    const start = Date.now();
    runHook("session-start.js", baseInput);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});

// ── session-start-setup.js integration tests ────────────────────────────────

describe("claude-code integration: session-start-setup.js (async hook)", () => {
  const baseInput = {
    session_id: "test-session-setup-001",
    cwd: "/tmp/test-project",
    hook_event_name: "SessionStart",
  };

  it("exits cleanly when HIVEMIND_WIKI_WORKER=1", () => {
    const raw = runHook("session-start-setup.js", baseInput, { HIVEMIND_WIKI_WORKER: "1" });
    // Fire-and-forget hook: no stdout expected
    expect(raw).toBe("");
  });

  it("exits cleanly with no credentials (HIVEMIND_TOKEN='')", () => {
    // Should not throw — just exits gracefully
    const raw = runHook("session-start-setup.js", baseInput);
    // No stdout output expected from async fire-and-forget hook
    expect(raw).toBe("");
  });

  it("does NOT produce stdout output (fire-and-forget)", () => {
    const raw = runHook("session-start-setup.js", baseInput);
    expect(raw).toBe("");
  });
});
