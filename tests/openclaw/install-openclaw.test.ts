import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for installOpenclaw() — the CLI installer that copies the openclaw
 * plugin bundle to ~/.openclaw/extensions/hivemind/ AND patches
 * ~/.openclaw/openclaw.json to include "hivemind" in both plugins.allow and
 * tools.alsoAllow (when each is an explicit array). See issue #121.
 *
 * The chicken-and-egg problem this fixes: OpenClaw's plugin loader gates on
 * plugins.allow before any of the plugin's registered slash commands become
 * reachable, so a freshly-installed plugin that's missing from plugins.allow
 * cannot fix its own visibility via /hivemind_setup — the slash command
 * isn't reachable. The installer has to patch out-of-band.
 *
 * homedir() is mocked via vi.mock("node:os") so the installer targets a
 * temp dir we control, mirroring the pattern in setup-command.test.ts.
 */

let TEMP_HOME = "";

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => TEMP_HOME };
});

beforeEach(() => {
  TEMP_HOME = mkdtempSync(join(tmpdir(), "hivemind-install-openclaw-test-"));
});

afterEach(() => {
  if (TEMP_HOME && existsSync(TEMP_HOME)) {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  }
});

function writeConfig(body: Record<string, unknown>): string {
  const dir = join(TEMP_HOME, ".openclaw");
  const path = join(dir, "openclaw.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

async function loadInstaller(): Promise<{ installOpenclaw: () => unknown }> {
  vi.resetModules();
  return await import("../../src/cli/install-openclaw.js") as { installOpenclaw: () => unknown };
}

describe("installOpenclaw()", () => {
  it("copies the plugin bundle to ~/.openclaw/extensions/hivemind/", async () => {
    writeConfig({ tools: { alsoAllow: ["hivemind"] } });
    const { installOpenclaw } = await loadInstaller();
    installOpenclaw();

    const pluginDir = join(TEMP_HOME, ".openclaw", "extensions", "hivemind");
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(pluginDir, ".hivemind_version"))).toBe(true);
  });

  describe("openclaw.json patching (issue #121)", () => {
    it("adds 'hivemind' to plugins.allow when it's an explicit array missing hivemind", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki", "browser"] },
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toEqual(["memory-wiki", "browser", "hivemind"]);
    });

    it("adds 'hivemind' to tools.alsoAllow when missing", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki", "hivemind"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.tools.alsoAllow).toEqual(["memory_store", "hivemind"]);
    });

    it("patches BOTH arrays in a single run when both miss hivemind", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toContain("hivemind");
      expect(updated.tools.alsoAllow).toContain("hivemind");
    });

    it("is idempotent — no patch when both arrays already include hivemind", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki", "hivemind"] },
        tools: { profile: "coding", alsoAllow: ["hivemind"] },
      });
      const before = readFileSync(configPath, "utf-8");
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const after = readFileSync(configPath, "utf-8");
      expect(after).toBe(before);
      // And: no backup file written when nothing changed.
      const backups = readdirSync(join(TEMP_HOME, ".openclaw")).filter(n => n.startsWith("openclaw.json.bak-hivemind-"));
      expect(backups).toEqual([]);
    });

    it("leaves plugins.allow ABSENT when it isn't already present (default-allow semantics)", async () => {
      const configPath = writeConfig({
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      // plugins.allow must NOT be created — that would silently flip the
      // user from default-allow to explicit-allowlist mode and break
      // every other plugin they have installed.
      expect(updated.plugins).toBeUndefined();
      // tools.alsoAllow is still patched.
      expect(updated.tools.alsoAllow).toContain("hivemind");
    });

    it("leaves plugins.allow ALONE when it's an empty array (default-allow semantics)", async () => {
      const configPath = writeConfig({
        plugins: { allow: [] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(updated.plugins.allow).toEqual([]);
    });

    it("writes a timestamped backup before patching", async () => {
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const before = readFileSync(configPath, "utf-8");
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();

      const backups = readdirSync(join(TEMP_HOME, ".openclaw")).filter(n => n.startsWith("openclaw.json.bak-hivemind-"));
      expect(backups.length).toBe(1);
      const backupBody = readFileSync(join(TEMP_HOME, ".openclaw", backups[0]), "utf-8");
      expect(backupBody).toBe(before);
    });

    it("doesn't crash when openclaw.json is absent (openclaw never run)", async () => {
      // No .openclaw/ dir at all.
      const { installOpenclaw } = await loadInstaller();
      expect(() => installOpenclaw()).not.toThrow();

      const pluginDir = join(TEMP_HOME, ".openclaw", "extensions", "hivemind");
      expect(existsSync(pluginDir)).toBe(true);
    });

    it("doesn't crash when openclaw.json is malformed JSON", async () => {
      const dir = join(TEMP_HOME, ".openclaw");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "openclaw.json"), "{ this is not json");
      const { installOpenclaw } = await loadInstaller();
      expect(() => installOpenclaw()).not.toThrow();
    });

    it("does not duplicate 'hivemind' if it sneaks in twice", async () => {
      // Real-world configs sometimes have duplicate entries from manual
      // edits + automated edits. Adding once should leave a single entry.
      const configPath = writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const { installOpenclaw } = await loadInstaller();
      installOpenclaw();
      // Run a second time — must remain idempotent.
      installOpenclaw();

      const updated = JSON.parse(readFileSync(configPath, "utf-8"));
      const allow = updated.plugins.allow as string[];
      const also = updated.tools.alsoAllow as string[];
      expect(allow.filter(x => x === "hivemind").length).toBe(1);
      expect(also.filter(x => x === "hivemind").length).toBe(1);
    });

    it("prints a restart hint when the config was patched", async () => {
      writeConfig({
        plugins: { allow: ["memory-wiki"] },
        tools: { profile: "coding", alsoAllow: ["memory_store"] },
      });
      const logs: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        return true;
      }) as typeof process.stdout.write;
      try {
        const { installOpenclaw } = await loadInstaller();
        installOpenclaw();
      } finally {
        process.stdout.write = origWrite;
      }
      const out = logs.join("");
      expect(out).toMatch(/restart/i);
      // No-backfill caveat must also surface so users don't expect old turns to land.
      expect(out).toMatch(/next turn|no backfill/i);
    });
  });
});
