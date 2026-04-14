import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const codexRoot = join(__dir, "..");

describe("codex hooks.json", () => {
  const hooks = JSON.parse(readFileSync(join(codexRoot, "hooks", "hooks.json"), "utf-8"));

  it("has the expected 5 lifecycle events", () => {
    const events = Object.keys(hooks.hooks);
    expect(events).toContain("SessionStart");
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("Stop");
    expect(events).toHaveLength(5);
  });

  it("does NOT have Claude Code-specific events", () => {
    const events = Object.keys(hooks.hooks);
    expect(events).not.toContain("SubagentStop");
    expect(events).not.toContain("SessionEnd");
  });

  it("PreToolUse matcher is Bash only", () => {
    const preToolUse = hooks.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe("Bash");
  });

  it("PostToolUse has no matcher (captures all tools)", () => {
    const postToolUse = hooks.hooks.PostToolUse;
    expect(postToolUse).toHaveLength(1);
    expect(postToolUse[0].matcher).toBeUndefined();
  });

  it("SessionStart matcher includes startup and resume", () => {
    const sessionStart = hooks.hooks.SessionStart;
    expect(sessionStart[0].matcher).toBe("startup|resume");
  });

  it("SessionStart timeout is <= 15s (regression: was 120s)", () => {
    const sessionStart = hooks.hooks.SessionStart;
    for (const hook of sessionStart[0].hooks) {
      expect(hook.timeout).toBeLessThanOrEqual(15);
    }
  });

  it("no hooks use the async flag (not supported in Codex)", () => {
    for (const [, entries] of Object.entries(hooks.hooks) as [string, any[]][]) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook).not.toHaveProperty("async");
        }
      }
    }
  });

  it("Stop hook uses a separate stop.js (not capture.js)", () => {
    const stop = hooks.hooks.Stop;
    expect(stop[0].hooks[0].command).toContain("stop.js");
    expect(stop[0].hooks[0].command).not.toContain("capture.js");
  });
});

describe("codex plugin.json", () => {
  const plugin = JSON.parse(readFileSync(join(codexRoot, ".codex-plugin", "plugin.json"), "utf-8"));

  it("has required fields", () => {
    expect(plugin.name).toBe("hivemind");
    expect(plugin.version).toBeTruthy();
    expect(plugin.description).toBeTruthy();
  });

  it("has Codex-specific interface block", () => {
    expect(plugin.interface).toBeDefined();
    expect(plugin.interface.displayName).toBeTruthy();
    expect(plugin.interface.developerName).toBe("Activeloop");
    expect(plugin.interface.category).toBeTruthy();
  });

  it("has arrays for skills, mcpServers, apps", () => {
    expect(Array.isArray(plugin.skills)).toBe(true);
    expect(Array.isArray(plugin.mcpServers)).toBe(true);
    expect(Array.isArray(plugin.apps)).toBe(true);
  });
});

describe("codex bundle output", () => {
  const bundleDir = join(codexRoot, "bundle");

  const expectedFiles = [
    "session-start.js",
    "session-start-setup.js",
    "capture.js",
    "pre-tool-use.js",
    "stop.js",
    "wiki-worker.js",
    "shell/deeplake-shell.js",
    "commands/auth-login.js",
  ];

  for (const file of expectedFiles) {
    it(`bundle contains ${file}`, () => {
      const content = readFileSync(join(bundleDir, file), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  }
});
