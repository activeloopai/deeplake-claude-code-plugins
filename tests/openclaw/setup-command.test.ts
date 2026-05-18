import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for /hivemind_setup — verifies the command correctly edits
 * openclaw.json's tools.alsoAllow to include "hivemind", writes a backup, and
 * is idempotent across re-runs.
 *
 * Uses vi.mock on node:os.homedir so the helper targets a temp dir we control.
 */

let TEMP_HOME = "";

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => TEMP_HOME };
});

// Stub out modules that would otherwise spin up network or call the real SDK.
vi.mock("../../src/config.js", () => ({
  loadConfig: () => null,
}));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: () => null,
  saveCredentials: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
  listOrgs: vi.fn().mockResolvedValue([]),
  switchOrg: vi.fn(),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  switchWorkspace: vi.fn(),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query() { return []; }
    listTables() { return []; }
    ensureSessionsTable() { return Promise.resolve(); }
    ensureTable() { return Promise.resolve(); }
  },
}));

type CommandRegistration = {
  name: string;
  description: string;
  handler: (ctx: { args?: string }) => Promise<string | { text: string }>;
};

async function loadSetupCommand(): Promise<CommandRegistration> {
  vi.resetModules();
  const mod = await import("../../openclaw/src/index.js");
  const plugin = mod.default as { register: (api: any) => void };
  const commands: CommandRegistration[] = [];
  plugin.register({
    logger: { info: vi.fn(), error: vi.fn() },
    on: vi.fn(),
    registerCommand: (cmd: CommandRegistration) => { commands.push(cmd); },
    registerTool: vi.fn(),
    registerMemoryCorpusSupplement: vi.fn(),
  });
  const setup = commands.find(c => c.name === "hivemind_setup");
  if (!setup) throw new Error("hivemind_setup command not registered");
  return setup;
}

function writeConfig(body: Record<string, unknown>): string {
  const dir = join(TEMP_HOME, ".openclaw");
  const path = join(dir, "openclaw.json");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-setup-test-"));
});

afterEach(() => {
  if (TEMP_HOME && existsSync(TEMP_HOME)) {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  }
});

describe("/hivemind_setup", () => {
  it("adds 'hivemind' to alsoAllow when it's not present", async () => {
    const configPath = writeConfig({
      tools: { profile: "coding", alsoAllow: ["memory_store"] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("Added");

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.tools.alsoAllow).toEqual(["memory_store", "hivemind"]);
  });

  it("writes a timestamped backup of the original config", async () => {
    const configPath = writeConfig({
      tools: { profile: "coding", alsoAllow: ["memory_store"] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    const match = result.text.match(/Backup of previous config: (.+)$/m);
    expect(match).toBeTruthy();
    const backupPath = match![1].trim();
    expect(existsSync(backupPath)).toBe(true);
    expect(backupPath.startsWith(`${configPath}.bak-hivemind-`)).toBe(true);

    const backupBody = JSON.parse(readFileSync(backupPath, "utf-8"));
    expect(backupBody.tools.alsoAllow).toEqual(["memory_store"]);
  });

  it("is idempotent — reports already-set when 'hivemind' is there", async () => {
    writeConfig({
      tools: { profile: "coding", alsoAllow: ["memory_store", "hivemind"] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("already enabled");
  });

  it("recognizes 'group:plugins' wildcard as already-set", async () => {
    writeConfig({
      tools: { profile: "coding", alsoAllow: ["group:plugins"] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("already enabled");
  });

  it("recognizes specific hivemind_* tool names as already-set", async () => {
    writeConfig({
      tools: { profile: "coding", alsoAllow: ["hivemind_search", "hivemind_read"] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("already enabled");
  });

  it("does NOT create alsoAllow when it's missing entirely (default-allow semantics)", async () => {
    // CodeRabbit on #124 caught this: my original code coerced an absent
    // tools.alsoAllow to [] then patched it to ["hivemind"], flipping the
    // user from default-allow into explicit-allowlist mode and potentially
    // disabling tools from other plugins. Match the same explicit-only
    // contract used for plugins.allow.
    const configPath = writeConfig({
      tools: { profile: "coding" },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    // No change → already-set
    expect(result.text).toContain("already enabled");

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.tools.alsoAllow).toBeUndefined();
  });

  it("does NOT touch alsoAllow when it's an empty array (default-allow semantics)", async () => {
    const configPath = writeConfig({
      tools: { profile: "coding", alsoAllow: [] },
    });
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("already enabled");

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.tools.alsoAllow).toEqual([]);
  });

  it("reports a parse error when openclaw.json is not valid JSON", async () => {
    const dir = join(TEMP_HOME, ".openclaw");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openclaw.json"), "{ broken json");
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("Could not update allowlist");
  });

  it("reports error when openclaw.json doesn't exist", async () => {
    // TEMP_HOME exists but no .openclaw/ dir inside
    const setup = await loadSetupCommand();
    const result = await setup.handler({}) as { text: string };
    expect(result.text).toContain("not found");
  });

  it("preserves unrelated top-level keys (agents, channels, plugins)", async () => {
    const configPath = writeConfig({
      meta: { lastTouchedVersion: "2026.4.21" },
      agents: { defaults: { model: "anthropic/claude-haiku-4-5-20251001" } },
      tools: { profile: "coding", alsoAllow: ["memory_store"] },
      channels: { telegram: { enabled: true } },
    });
    const setup = await loadSetupCommand();
    await setup.handler({});

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.meta.lastTouchedVersion).toBe("2026.4.21");
    expect(updated.agents.defaults.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(updated.channels.telegram.enabled).toBe(true);
    expect(updated.tools.profile).toBe("coding");
    expect(updated.tools.alsoAllow).toContain("hivemind");
  });

  // plugins.allow gating — issue #121. OpenClaw refuses to load the
  // hivemind plugin at all when plugins.allow is an explicit non-empty
  // array missing "hivemind", so the slash command was previously
  // unreachable on a freshly-installed plugin. /hivemind_setup must
  // patch both arrays (where each exists as an explicit list) so a
  // single run fully unblocks the plugin once it has been registered
  // out-of-band.
  describe("plugins.allow gating (issue #121)", () => {
    it("adds 'hivemind' to plugins.allow when it's an explicit array missing hivemind", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki", "browser"] },
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      const setup = await loadSetupCommand();
      const result = await setup.handler({}) as { text: string };
      expect(result.text).toContain("Added");

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toEqual(["memory-wiki", "browser", "hivemind"]);
    });

    it("patches BOTH plugins.allow and tools.alsoAllow in a single run when both miss hivemind", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const setup = await loadSetupCommand();
      const result = await setup.handler({}) as { text: string };
      expect(result.text).toContain("Added");

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toEqual(["memory-wiki", "hivemind"]);
      expect(updated.tools.alsoAllow).toEqual(["memory_store", "hivemind"]);
    });

    it("does NOT create plugins.allow when it's absent (default-allow semantics)", async () => {
      const configPath = writeConfig({
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const setup = await loadSetupCommand();
      await setup.handler({});

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins).toBeUndefined();
    });

    it("does NOT touch plugins.allow when it's an empty array (default-allow semantics)", async () => {
      const configPath = writeConfig({
        plugins: { allow: [] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const setup = await loadSetupCommand();
      await setup.handler({});

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toEqual([]);
    });

    it("is idempotent when 'hivemind' is already in plugins.allow AND tools.alsoAllow", async () => {
      writeConfig({
        plugins: { allow: ["memory-wiki", "hivemind"] },
        tools: { profile: "coding", alsoAllow: ["memory_store", "hivemind"] },
      });
      const setup = await loadSetupCommand();
      const result = await setup.handler({}) as { text: string };
      expect(result.text).toContain("already enabled");
    });

    it("reports 'Added' even when only plugins.allow needs patching (tools.alsoAllow already covers hivemind)", async () => {
      // group:plugins wildcard covers tools.alsoAllow, but plugins.allow
      // still needs an explicit "hivemind" entry.
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["group:plugins"] },
      });
      const setup = await loadSetupCommand();
      const result = await setup.handler({}) as { text: string };
      expect(result.text).toContain("Added");

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toContain("hivemind");
      // tools.alsoAllow was already covered by the wildcard — left as-is.
      expect(updated.tools.alsoAllow).toEqual(["group:plugins"]);
    });

    it("detectAllowlistMissing returns true when only plugins.allow is missing hivemind", async () => {
      writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      vi.resetModules();
      const { detectAllowlistMissing } = await import("../../openclaw/src/setup-config.js");
      expect(detectAllowlistMissing()).toBe(true);
    });

    it("detectAllowlistMissing returns false when both allowlists cover hivemind", async () => {
      writeConfig({
        plugins: { allow: ["memory-wiki", "hivemind"] },
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      vi.resetModules();
      const { detectAllowlistMissing } = await import("../../openclaw/src/setup-config.js");
      expect(detectAllowlistMissing()).toBe(false);
    });

    it("detectAllowlistMissing returns false when plugins.allow is absent (default-allow)", async () => {
      writeConfig({
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      vi.resetModules();
      const { detectAllowlistMissing } = await import("../../openclaw/src/setup-config.js");
      expect(detectAllowlistMissing()).toBe(false);
    });
  });
});
