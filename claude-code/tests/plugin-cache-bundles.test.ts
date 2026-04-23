import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guard: the snapshot/restore dance must survive the
 * esbuild pass — if it doesn't, SessionStart updates will wipe the
 * live plugin dir again and break in-flight sessions (the bug we just
 * fixed). Scan the shipped bundles.
 */

const claudeCodeBundleDir = join(__dirname, "..", "bundle");

describe("shipped bundles contain plugin-cache safety", () => {
  it("session-start-setup.js calls snapshotPluginDir and restoreOrCleanup", () => {
    const src = readFileSync(join(claudeCodeBundleDir, "session-start-setup.js"), "utf-8");
    expect(src).toMatch(/snapshotPluginDir/);
    expect(src).toMatch(/restoreOrCleanup/);
    expect(src).toMatch(/resolveVersionedPluginDir/);
  });

  it("plugin-cache-gc.js bundle exists and calls planGc + executeGc", () => {
    const src = readFileSync(join(claudeCodeBundleDir, "plugin-cache-gc.js"), "utf-8");
    expect(src).toMatch(/planGc/);
    expect(src).toMatch(/executeGc/);
    expect(src).toMatch(/readCurrentVersionFromManifest/);
  });

  it("hooks.json wires plugin-cache-gc into SessionEnd", () => {
    const hooks = JSON.parse(readFileSync(join(__dirname, "..", "hooks", "hooks.json"), "utf-8"));
    const sessionEnd = hooks.hooks.SessionEnd?.[0]?.hooks ?? [];
    const gcEntry = sessionEnd.find((h: any) => typeof h.command === "string" && h.command.includes("plugin-cache-gc.js"));
    expect(gcEntry).toBeTruthy();
    expect(gcEntry.async).toBe(true);
  });
});
