import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, cpSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test: runs the *shipped* plugin-cache-gc.js bundle as a
 * node subprocess against a fake HOME. This is the closest we get to
 * what happens inside a real Claude session without touching the user's
 * real plugin cache.
 *
 * Requires the bundle to be built (`npm run build`). Skipped if missing.
 */

const bundlePath = resolve(__dirname, "..", "bundle", "plugin-cache-gc.js");
const bundleExists = existsSync(bundlePath);

function makeFakeHome(): string {
  const home = join(tmpdir(), `hivemind-gc-it-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, ".claude", "plugins", "cache", "hivemind", "hivemind"), { recursive: true });
  mkdirSync(join(home, ".deeplake"), { recursive: true });
  return home;
}

function mkVersion(home: string, version: string): string {
  const v = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind", version);
  mkdirSync(join(v, "bundle"), { recursive: true });
  writeFileSync(join(v, "bundle", "marker.txt"), version);
  return v;
}

function writeManifest(home: string, version: string): void {
  const manifest = {
    version: 2,
    plugins: {
      "hivemind@hivemind": [{
        scope: "user",
        installPath: join(home, ".claude", "plugins", "cache", "hivemind", "hivemind", version),
        version,
      }],
    },
  };
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(manifest));
}

function runGcBundle(home: string, bundleInsideHome: string): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [bundleInsideHome], {
      env: { ...process.env, HOME: home, HIVEMIND_DEBUG: "0" },
      input: "",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    return { stdout, stderr: "" };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe.skipIf(!bundleExists)("plugin-cache-gc shipped bundle", () => {
  beforeAll(() => {
    // Fail loud if someone tries to run this without a build.
    if (!bundleExists) throw new Error(`missing bundle at ${bundlePath} — run npm run build`);
  });

  it("keeps current + two previous, deletes older versions and dead-PID snapshots", () => {
    const home = makeFakeHome();
    try {
      const versionsRoot = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind");
      mkVersion(home, "0.6.36");
      mkVersion(home, "0.6.37");
      mkVersion(home, "0.6.38");
      const current = mkVersion(home, "0.6.39");
      // A stale snapshot belonging to a PID that is not alive (9999999 is virtually
      // guaranteed to be above the kernel PID max on Linux).
      mkdirSync(`${join(versionsRoot, "0.6.37")}.keep-9999999`, { recursive: true });
      writeManifest(home, "0.6.39");

      // Copy the built GC bundle into the fake cache so __bundleDir resolves inside it.
      cpSync(bundlePath, join(current, "bundle", "plugin-cache-gc.js"));
      const gcInsideHome = join(current, "bundle", "plugin-cache-gc.js");

      runGcBundle(home, gcInsideHome);

      const remaining = readdirSync(versionsRoot).sort();
      // DEFAULT_KEEP_COUNT=3: current + two newest predecessors survive.
      expect(remaining).toEqual(["0.6.37", "0.6.38", "0.6.39"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves live-PID snapshots", () => {
    const home = makeFakeHome();
    try {
      const versionsRoot = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind");
      mkVersion(home, "0.6.38");
      const current = mkVersion(home, "0.6.39");
      // Our own PID is alive; the GC must not touch this snapshot.
      const liveSnapshot = `${join(versionsRoot, "0.6.38")}.keep-${process.pid}`;
      mkdirSync(liveSnapshot, { recursive: true });
      writeManifest(home, "0.6.39");

      cpSync(bundlePath, join(current, "bundle", "plugin-cache-gc.js"));
      runGcBundle(home, join(current, "bundle", "plugin-cache-gc.js"));

      expect(existsSync(liveSnapshot)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("deletes nothing when manifest is missing (bail-safe)", () => {
    const home = makeFakeHome();
    try {
      const versionsRoot = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind");
      mkVersion(home, "0.6.37");
      mkVersion(home, "0.6.38");
      const current = mkVersion(home, "0.6.39");
      // No installed_plugins.json written.
      cpSync(bundlePath, join(current, "bundle", "plugin-cache-gc.js"));
      runGcBundle(home, join(current, "bundle", "plugin-cache-gc.js"));

      const remaining = readdirSync(versionsRoot).sort();
      expect(remaining).toEqual(["0.6.37", "0.6.38", "0.6.39"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips silently when bundle is in a local --plugin-dir layout (not under ~/.claude/plugins/cache)", () => {
    const sandbox = join(tmpdir(), `hivemind-dev-it-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(sandbox, "claude-code", "bundle"), { recursive: true });
    try {
      cpSync(bundlePath, join(sandbox, "claude-code", "bundle", "plugin-cache-gc.js"));
      const { stdout, stderr } = runGcBundle(sandbox, join(sandbox, "claude-code", "bundle", "plugin-cache-gc.js"));
      // Must not crash; output is fine to be empty.
      expect(stderr).not.toMatch(/TypeError|ReferenceError|Cannot find module/);
      // The sandbox dir should be unchanged.
      expect(statSync(join(sandbox, "claude-code")).isDirectory()).toBe(true);
      expect(stdout).toBe("");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
