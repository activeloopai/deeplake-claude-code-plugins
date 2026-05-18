import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePluginNodeModulesLink } from "../../src/embeddings/self-heal.js";

let root: string;
let pluginDir: string;
let bundleDir: string;
let sharedNodeModules: string;
let link: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hvm-self-heal-"));
  pluginDir = join(root, "plugin-v1");
  bundleDir = join(pluginDir, "bundle");
  sharedNodeModules = join(root, ".hivemind", "embed-deps", "node_modules");
  link = join(pluginDir, "node_modules");
  mkdirSync(bundleDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensurePluginNodeModulesLink", () => {
  it("creates the symlink when shared deps exist and plugin has no node_modules", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("linked");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(sharedNodeModules);
  });

  it("returns shared-deps-missing (no-op) when the target node_modules does not exist", () => {
    // Don't create sharedNodeModules.
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("shared-deps-missing");
    expect(existsSync(link)).toBe(false);
  });

  it("is idempotent: re-call when link already points at target returns already-linked", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("already-linked");
    expect(readlinkSync(link)).toBe(sharedNodeModules);
  });

  it("does NOT clobber an existing real node_modules directory", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "marker.txt"), "do not delete");
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("plugin-owns-node-modules");
    // Real dir still there with its marker.
    expect(existsSync(join(link, "marker.txt"))).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it("does NOT clobber a symlink that points somewhere else (real target)", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    const elsewhere = join(root, "elsewhere-nm");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, link);
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("linked-elsewhere");
    if (r.kind === "linked-elsewhere") {
      expect(r.existingTarget).toBe(elsewhere);
    }
    // Pre-existing symlink preserved.
    expect(readlinkSync(link)).toBe(elsewhere);
  });

  it("repairs a DANGLING symlink in the SAME call (no two-pass recovery)", () => {
    // Regression for CodeRabbit #3/#13: previously this branch removed
    // the stale link and returned, leaving the current hook run without
    // a working `node_modules` link until a second invocation. Now the
    // helper removes the dangling link AND immediately re-creates it
    // pointing at the correct shared target, so a single call is enough.
    mkdirSync(sharedNodeModules, { recursive: true });
    const danglingTarget = join(root, "gone");
    mkdirSync(danglingTarget);
    symlinkSync(danglingTarget, link);
    // Now delete the target — link is dangling.
    rmSync(danglingTarget, { recursive: true, force: true });

    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    // Diagnostic preserved: the result kind still reports we removed a
    // stale link (with the original dangling target) so callers can log
    // the recovery. But the link is now alive and points at shared.
    expect(r.kind).toBe("stale-link-removed");
    expect(existsSync(link)).toBe(true);
    expect(readlinkSync(link)).toBe(sharedNodeModules);
  });

  it("computes pluginDir as dirname(bundleDir) (mirrors the agent layout)", () => {
    // If the helper miscomputed pluginDir (e.g. used bundleDir directly),
    // the symlink would land at <bundle>/node_modules. Assert it lands at
    // <plugin>/node_modules.
    mkdirSync(sharedNodeModules, { recursive: true });
    ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(existsSync(join(pluginDir, "node_modules"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules"))).toBe(false);
  });

  it("creates the parent directory if missing (defensive against unusual install layouts)", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    // Remove pluginDir entirely (no bundle/, nothing).
    rmSync(pluginDir, { recursive: true, force: true });
    mkdirSync(bundleDir, { recursive: true }); // recreate bundle (parent comes back)
    rmSync(pluginDir, { recursive: true, force: true });
    // Now pluginDir is gone again; the helper should mkdir it before symlinking.
    const r = ensurePluginNodeModulesLink({ bundleDir, sharedNodeModules });
    expect(r.kind).toBe("linked");
    expect(readlinkSync(link)).toBe(sharedNodeModules);
  });

  it("refuses to act when bundleDir basename is not 'bundle' (test-tree / source-tree safety)", () => {
    mkdirSync(sharedNodeModules, { recursive: true });
    // Mimic the source-tree path where capture.ts lives in `src/hooks/`,
    // not in a `bundle/` dir. Without this gate, importing the capture
    // module from tests would silently symlink src/node_modules to the
    // user's real shared deps.
    const wrongDir = join(root, "wrong-layout", "hooks");
    mkdirSync(wrongDir, { recursive: true });
    const r = ensurePluginNodeModulesLink({ bundleDir: wrongDir, sharedNodeModules });
    expect(r.kind).toBe("not-bundle-layout");
    // No symlink created in the bogus parent.
    expect(existsSync(join(root, "wrong-layout", "node_modules"))).toBe(false);
  });
});
