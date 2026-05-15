import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guards on the shipped Claude Code bundles.
 *
 * Historical context: an earlier bug had session-start-setup.js wiping
 * the live plugin dir during in-session marketplace updates. The fix
 * was a snapshot/restore dance around the `claude plugin update`
 * execSync. After PR #97's autoupdate centralization, that whole
 * marketplace-update path is gone — the hook now calls the shared
 * autoUpdate helper which fire-and-forgets a detached `hivemind
 * update`. So `snapshotPluginDir`/`restoreOrCleanup` are no longer
 * referenced from session-start-setup.js (they live elsewhere now).
 *
 * The plugin-cache-gc bundle still has its own job (cleaning old
 * versioned dirs at SessionEnd) and that's still asserted below.
 */

const claudeCodeRoot = join(process.cwd(), "claude-code");
const claudeCodeBundleDir = join(claudeCodeRoot, "bundle");

describe("shipped bundles contain plugin-cache safety", () => {
  it("session-start-setup.js does NOT reach for snapshotPluginDir or execSync (centralized via autoUpdate)", () => {
    const src = readFileSync(join(claudeCodeBundleDir, "session-start-setup.js"), "utf-8");
    // Negative pattern: the legacy snapshot/restore dance must not be
    // re-introduced. autoUpdate handles upgrade serialization via its
    // own helper; the hook just dispatches.
    expect(src).not.toMatch(/snapshotPluginDir/);
    expect(src).not.toMatch(/restoreOrCleanup/);
    expect(src).not.toMatch(/claude plugin update/);
    // Positive pattern: the centralized helper must be reachable.
    expect(src).toMatch(/autoUpdate/);
  });

  it("plugin-cache-gc.js bundle exists and calls planGc + executeGc", () => {
    const src = readFileSync(join(claudeCodeBundleDir, "plugin-cache-gc.js"), "utf-8");
    expect(src).toMatch(/planGc/);
    expect(src).toMatch(/executeGc/);
    expect(src).toMatch(/readCurrentVersionFromManifest/);
  });

  it("hooks.json wires plugin-cache-gc into SessionEnd", () => {
    const hooks = JSON.parse(readFileSync(join(claudeCodeRoot, "hooks", "hooks.json"), "utf-8"));
    const sessionEnd = hooks.hooks.SessionEnd?.[0]?.hooks ?? [];
    const gcEntry = sessionEnd.find((h: any) => typeof h.command === "string" && h.command.includes("plugin-cache-gc.js"));
    expect(gcEntry).toBeTruthy();
    expect(gcEntry.async).toBe(true);
  });
});
