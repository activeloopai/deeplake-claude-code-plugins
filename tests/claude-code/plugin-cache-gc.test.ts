import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { runGc } from "../../src/hooks/plugin-cache-gc.js";

/**
 * Unit tests for the runGc orchestrator in plugin-cache-gc.ts. The
 * `resolveVersionedPluginDir` helper only returns a non-null value when
 * the bundleDir sits under `~/.claude/plugins/cache/hivemind/hivemind/<semver>/bundle/`.
 * We can construct that real-looking path under a tmp root by pointing
 * into the current user's home — no files are written until runGc calls
 * a helper that uses it, and we pass an explicit manifestPath so we
 * never touch the real installed_plugins.json.
 */

function mkRoot(): string {
  const root = join(tmpdir(), `pcgc-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

// Build a real versioned plugin layout under ~/.claude/plugins/cache/hivemind/hivemind/<v>/.
// We use a uniquely-named top-level cache dir inside ~/.claude/plugins/cache/ so we don't
// clobber any real hivemind install, then fabricate versions beneath it.
function mkFakeVersionedLayout(): {
  bundleDir: string;
  versionsRoot: string;
  cleanup: () => void;
} {
  const unique = `hivemind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Inside the hivemind org-dir, siblings of versions are dirs. Make a sandbox
  // org-dir to avoid touching the real one.
  const sandboxOrg = join(homedir(), ".claude", "plugins", "cache", unique);
  // resolveVersionedPluginDir looks for parent dir named "hivemind" (the inner
  // one), so mirror that name inside our sandbox org.
  const versionsRoot = join(sandboxOrg, "hivemind");
  mkdirSync(versionsRoot, { recursive: true });
  const bundleDir = join(versionsRoot, "0.6.39", "bundle");
  return {
    bundleDir,
    versionsRoot,
    cleanup: () => rmSync(sandboxOrg, { recursive: true, force: true }),
  };
}

describe("runGc", () => {
  let root: string;
  let logs: string[];
  let log: (m: string) => void;

  beforeEach(() => {
    root = mkRoot();
    logs = [];
    log = (m: string) => { logs.push(m); };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns early when HIVEMIND_WIKI_WORKER=1 (no log of skip)", () => {
    const prev = process.env.HIVEMIND_WIKI_WORKER;
    process.env.HIVEMIND_WIKI_WORKER = "1";
    try {
      runGc("/anything", { log });
      expect(logs).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.HIVEMIND_WIKI_WORKER;
      else process.env.HIVEMIND_WIKI_WORKER = prev;
    }
  });

  it("logs and returns when bundleDir is not a versioned install", () => {
    runGc(join(root, "claude-code", "bundle"), { log });
    expect(logs).toContain("not a versioned install, skipping");
  });

  it("logs 'nothing to gc' when plan has no deletions", () => {
    // Resolvable layout with a single version that is also the manifest's current.
    const layout = mkFakeVersionedLayout();
    try {
      mkdirSync(join(layout.versionsRoot, "0.6.39"), { recursive: true });
      const manifestPath = join(root, "installed_plugins.json");
      writeFileSync(manifestPath, JSON.stringify({
        plugins: { "hivemind@hivemind": [{ version: "0.6.39" }] },
      }));
      runGc(layout.bundleDir, { log, manifestPath });
      expect(logs.some(l => l.startsWith("nothing to gc"))).toBe(true);
    } finally {
      layout.cleanup();
    }
  });

  it("deletes older versions and logs the gc summary", () => {
    const layout = mkFakeVersionedLayout();
    try {
      for (const v of ["0.6.36", "0.6.37", "0.6.38", "0.6.39"]) {
        mkdirSync(join(layout.versionsRoot, v), { recursive: true });
      }
      const manifestPath = join(root, "installed_plugins.json");
      writeFileSync(manifestPath, JSON.stringify({
        plugins: { "hivemind@hivemind": [{ version: "0.6.39" }] },
      }));
      runGc(layout.bundleDir, { log, manifestPath });

      // DEFAULT_KEEP_COUNT = 3 → keep 0.6.39 + 0.6.38 + 0.6.37; delete 0.6.36
      const remaining = readdirSync(layout.versionsRoot).sort();
      expect(remaining).toEqual(["0.6.37", "0.6.38", "0.6.39"]);
      expect(logs.some(l => l.startsWith("gc kept=") && l.includes("deletedVersions=0.6.36"))).toBe(true);
    } finally {
      layout.cleanup();
    }
  });

  it("respects an explicit keepCount override", () => {
    const layout = mkFakeVersionedLayout();
    try {
      for (const v of ["0.6.37", "0.6.38", "0.6.39"]) {
        mkdirSync(join(layout.versionsRoot, v), { recursive: true });
      }
      const manifestPath = join(root, "installed_plugins.json");
      writeFileSync(manifestPath, JSON.stringify({
        plugins: { "hivemind@hivemind": [{ version: "0.6.39" }] },
      }));
      runGc(layout.bundleDir, { log, manifestPath, keepCount: 1 });

      const remaining = readdirSync(layout.versionsRoot).sort();
      expect(remaining).toEqual(["0.6.39"]);
    } finally {
      layout.cleanup();
    }
  });

  it("uses default log + manifest path when opts are omitted", () => {
    const layout = mkFakeVersionedLayout();
    try {
      // Put a non-matching version on disk: the real manifest's current
      // version (whatever is installed) won't be in this fake root, so
      // planGc bails without any deletions. This exercises the `??`
      // default branches for opts.log and opts.manifestPath without
      // altering the user's actual install.
      mkdirSync(join(layout.versionsRoot, "0.0.1"), { recursive: true });
      expect(() => runGc(layout.bundleDir)).not.toThrow();
      expect(existsSync(join(layout.versionsRoot, "0.0.1"))).toBe(true);
    } finally {
      layout.cleanup();
    }
  });

  it("deletes dead-PID snapshot dirs but preserves live-PID snapshots", () => {
    const layout = mkFakeVersionedLayout();
    try {
      for (const v of ["0.6.38", "0.6.39"]) {
        mkdirSync(join(layout.versionsRoot, v), { recursive: true });
      }
      const deadPidSnapshot = join(layout.versionsRoot, "0.6.38.keep-9999999");
      const livePidSnapshot = join(layout.versionsRoot, `0.6.38.keep-${process.pid}`);
      mkdirSync(deadPidSnapshot, { recursive: true });
      mkdirSync(livePidSnapshot, { recursive: true });
      const manifestPath = join(root, "installed_plugins.json");
      writeFileSync(manifestPath, JSON.stringify({
        plugins: { "hivemind@hivemind": [{ version: "0.6.39" }] },
      }));
      runGc(layout.bundleDir, { log, manifestPath });
      expect(existsSync(deadPidSnapshot)).toBe(false);
      expect(existsSync(livePidSnapshot)).toBe(true);
    } finally {
      layout.cleanup();
    }
  });
});
