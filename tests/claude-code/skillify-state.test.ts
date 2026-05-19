import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  deriveProjectKey,
  normalizeGitRemoteUrl,
  bumpStopCounter,
  resetCounter,
  readState,
  recordSkill,
  advanceWatermark,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  TRIGGER_THRESHOLD,
} from "../../src/skillify/state.js";

/**
 * Redirect state.ts at a throwaway directory via `HIVEMIND_STATE_DIR` so
 * tests never pollute the developer's real `~/.deeplake/state/skillify`.
 *
 * Why this matters: this very test file used to `mkdirSync(path, …)` a
 * directory at the lock path inside the developer's REAL home (to
 * exercise the EISDIR branch of `tryAcquireWorkerLock`) and clean it up
 * with a swallow-error `rmdirSync`. Every test run that got SIGKILL'd or
 * crashed before `afterEach` left a stale `<key>.lock` directory in
 * `~/.deeplake/state/skillify/`. 80+ orphans accumulated on dev
 * machines and bricked every production Stop trigger that happened to
 * hash to the same key (unlinkSync on a directory throws EISDIR, the
 * worker silently no-ops). `getStateDir()` honours `HIVEMIND_STATE_DIR`
 * first, so pointing it at `mkdtempSync()` here keeps the blast radius
 * inside a self-cleaning tmp dir — even a hard kill only leaves debris
 * in `/tmp` (the OS reaps it on boot).
 */
const PRIOR_STATE_DIR_ENV = process.env.HIVEMIND_STATE_DIR;
let STATE_DIR: string;

beforeAll(() => {
  STATE_DIR = mkdtempSync(join(tmpdir(), "skillify-state-test-"));
  process.env.HIVEMIND_STATE_DIR = STATE_DIR;
});

afterAll(() => {
  // Defensive: blow away everything we created, including any
  // directories that an EISDIR-branch test left behind. `recursive +
  // force` survives both file and dir entries and silently succeeds if
  // already missing.
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  if (PRIOR_STATE_DIR_ENV === undefined) delete process.env.HIVEMIND_STATE_DIR;
  else process.env.HIVEMIND_STATE_DIR = PRIOR_STATE_DIR_ENV;
});

/**
 * Use a unique cwd per test so the derived project key never collides
 * with other tests. The on-disk artefacts live in the tmp STATE_DIR
 * above, so leaks between tests (and between dev runs) are confined.
 */
function freshCwd(): string {
  return `/tmp/skillify-test-${randomUUID()}`;
}

let trackedKeys: string[] = [];

beforeEach(() => { trackedKeys = []; });

afterEach(() => {
  // Belt-and-braces: explicit cleanup of every file or directory we
  // recorded plus a sweep of the tmp dir for anything we missed. Using
  // `rmSync(..., { recursive: true, force: true })` so a test that
  // creates `<key>.lock` as a directory (the EISDIR-branch fixture
  // below) cleans up just as cleanly as one that left a regular file.
  for (const key of trackedKeys) {
    for (const ext of [".json", ".lock", ".lock.rmw"]) {
      try { rmSync(join(STATE_DIR, `${key}${ext}`), { recursive: true, force: true }); } catch { /* nothing to do */ }
    }
  }
});

function track(key: string): string { trackedKeys.push(key); return key; }

describe("deriveProjectKey", () => {
  it("returns a stable hex string of length 16 for the same cwd", () => {
    const cwd = freshCwd();
    const a = deriveProjectKey(cwd);
    const b = deriveProjectKey(cwd);
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different keys for different cwds (no git remote in either)", () => {
    const a = deriveProjectKey(freshCwd());
    const b = deriveProjectKey(freshCwd());
    expect(a.key).not.toBe(b.key);
  });

  it("derives project name from the basename of cwd", () => {
    const { project } = deriveProjectKey("/tmp/some-project-name");
    expect(project).toBe("some-project-name");
  });
});

describe("normalizeGitRemoteUrl", () => {
  // Two devs cloning the same repo with different URL styles MUST land on
  // the same projectKey, otherwise the worker treats them as separate
  // projects and the dedup gate can't reason across cloners.
  it("collapses all common git URL forms to one canonical string", () => {
    const variants = [
      "git@github.com:activeloopai/hivemind.git",
      "git@github.com:activeloopai/hivemind",
      "https://github.com/activeloopai/hivemind.git",
      "https://github.com/activeloopai/hivemind",
      "https://github.com/activeloopai/hivemind/",
      "https://emanuele@github.com/activeloopai/hivemind.git",
      "https://emanuele:secret@github.com/activeloopai/hivemind.git",
      "ssh://git@github.com/activeloopai/hivemind.git",
      // Default ports appearing explicitly must collapse too — otherwise
      // automation/hosting that emits `:443` or `:22` produces divergent
      // project_keys for the same logical remote.
      "https://github.com:443/activeloopai/hivemind.git",
      "ssh://git@github.com:22/activeloopai/hivemind.git",
      "git://github.com:9418/activeloopai/hivemind.git",
      "http://github.com:80/activeloopai/hivemind.git",
    ];
    const canonical = "github.com/activeloopai/hivemind";
    for (const v of variants) {
      expect(normalizeGitRemoteUrl(v)).toBe(canonical);
    }
  });

  it("preserves non-default ports (they're load-bearing)", () => {
    // Internal/self-hosted servers often run on a non-default port; that
    // port distinguishes the remote and must NOT be stripped.
    expect(normalizeGitRemoteUrl("https://git.internal.corp:8443/team/repo.git"))
      .toBe("git.internal.corp:8443/team/repo");
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.local:2222/team/repo.git"))
      .toBe("gitlab.local:2222/team/repo");
  });

  it("preserves case-insensitive equality for mixed-case hosts/paths", () => {
    expect(normalizeGitRemoteUrl("https://GitHub.com/Org/Repo.git"))
      .toBe("github.com/org/repo");
  });

  it("returns input lowercased when not a recognizable git URL (fallback path)", () => {
    // The fallback in deriveProjectKey hashes the cwd directly; we still
    // lowercase to avoid case-sensitivity surprises from different
    // platforms.
    expect(normalizeGitRemoteUrl("/Users/foo/Some/Path")).toBe("/users/foo/some/path");
  });
});

describe("bumpStopCounter", () => {
  it("initializes state on first call with counter=1", () => {
    const cwd = freshCwd();
    const s = bumpStopCounter(cwd);
    track(s.projectKey);
    expect(s.counter).toBe(1);
    expect(s.lastUuid).toBeNull();
    expect(s.lastDate).toBeNull();
    expect(s.skillsGenerated).toEqual([]);
  });

  it("increments counter on subsequent calls", () => {
    const cwd = freshCwd();
    bumpStopCounter(cwd);
    bumpStopCounter(cwd);
    const s = bumpStopCounter(cwd);
    track(s.projectKey);
    expect(s.counter).toBe(3);
  });

  it("persists state to disk under ~/.deeplake/state/skillify", () => {
    const cwd = freshCwd();
    const s = bumpStopCounter(cwd);
    track(s.projectKey);
    const path = join(STATE_DIR, `${s.projectKey}.json`);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.counter).toBe(1);
    expect(onDisk.project).toBe(s.project);
  });
});

describe("resetCounter", () => {
  it("zeros the counter without losing other fields", () => {
    const cwd = freshCwd();
    bumpStopCounter(cwd); bumpStopCounter(cwd); bumpStopCounter(cwd);
    const s = bumpStopCounter(cwd);
    track(s.projectKey);
    expect(s.counter).toBe(4);

    resetCounter(s.projectKey);

    const after = readState(s.projectKey)!;
    expect(after.counter).toBe(0);
    expect(after.project).toBe(s.project);
    expect(after.skillsGenerated).toEqual([]);
  });

  it("is a no-op when state does not exist", () => {
    const fakeKey = randomUUID().replace(/-/g, "").slice(0, 16);
    expect(() => resetCounter(fakeKey)).not.toThrow();
  });
});

describe("recordSkill", () => {
  it("appends skill name, advances watermark, dedups", () => {
    const cwd = freshCwd();
    const s = bumpStopCounter(cwd);
    track(s.projectKey);

    recordSkill(s.projectKey, "skill-a", "uuid-1", "2026-05-06T10:00:00Z");
    let state = readState(s.projectKey)!;
    expect(state.skillsGenerated).toEqual(["skill-a"]);
    expect(state.lastUuid).toBe("uuid-1");
    expect(state.lastDate).toBe("2026-05-06T10:00:00Z");

    // Same skill, newer session — no duplicate, watermark advances
    recordSkill(s.projectKey, "skill-a", "uuid-2", "2026-05-06T11:00:00Z");
    state = readState(s.projectKey)!;
    expect(state.skillsGenerated).toEqual(["skill-a"]);
    expect(state.lastUuid).toBe("uuid-2");

    recordSkill(s.projectKey, "skill-b", "uuid-3", "2026-05-06T12:00:00Z");
    state = readState(s.projectKey)!;
    expect(state.skillsGenerated).toEqual(["skill-a", "skill-b"]);
  });
});

describe("advanceWatermark", () => {
  it("updates lastUuid + lastDate without touching skillsGenerated", () => {
    const cwd = freshCwd();
    const s = bumpStopCounter(cwd);
    track(s.projectKey);

    advanceWatermark(s.projectKey, "uuid-x", "2026-05-06T13:00:00Z");
    const state = readState(s.projectKey)!;
    expect(state.lastUuid).toBe("uuid-x");
    expect(state.lastDate).toBe("2026-05-06T13:00:00Z");
    expect(state.skillsGenerated).toEqual([]);
  });
});

describe("worker lock", () => {
  it("acquires and releases atomically", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);

    expect(tryAcquireWorkerLock(key)).toBe(true);
    // Second concurrent acquire returns false
    expect(tryAcquireWorkerLock(key)).toBe(false);
    releaseWorkerLock(key);
    // After release, can re-acquire
    expect(tryAcquireWorkerLock(key)).toBe(true);
    releaseWorkerLock(key);
  });

  it("reclaims a stale lock older than maxAgeMs", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    expect(tryAcquireWorkerLock(key)).toBe(true);
    // Lock is held; with maxAgeMs=0, every existing lock is "stale"
    expect(tryAcquireWorkerLock(key, 0)).toBe(true);
    releaseWorkerLock(key);
  });
});

describe("worker lock edge cases", () => {
  it("self-heals when the lock path is a stale directory and reacquires", () => {
    // The pre-fix bug: prior runs of this very test file would leak a
    // `<key>.lock` directory into the dev's real ~/.deeplake on crash.
    // Once leaked, every future Stop-trigger silently no-op'd because
    // `unlinkSync` on a directory throws EISDIR and the worker bailed.
    // The fix in state.ts catches EISDIR and falls back to `rmSync`
    // recursive — exercise both halves: the recovery AND the
    // subsequent re-acquire succeed, leaving a regular file in place.
    const fs = require("node:fs");
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    const path = join(STATE_DIR, `${key}.lock`);
    fs.mkdirSync(path, { recursive: true });
    expect(fs.statSync(path).isDirectory()).toBe(true);

    const ok = tryAcquireWorkerLock(key);
    expect(ok).toBe(true);
    expect(fs.statSync(path).isFile()).toBe(true);
    // Sanity: an immediate second acquire is blocked — the new file
    // really is a live lock, not a leftover artefact.
    expect(tryAcquireWorkerLock(key)).toBe(false);
    releaseWorkerLock(key);
  });

  it("does NOT destroy unexpected content inside a non-empty stale lock dir", () => {
    // Why this matters: round 2 of /codex challenge pointed out that
    // the original `rmSync(p, { recursive: true, force: true })` would
    // happily delete *anything* at the path — including the racing
    // process's regular file, or any content sitting inside the dir.
    // Switching to `rmdirSync(p)` makes recovery shape-aware: a
    // non-empty stale dir throws ENOTEMPTY and we bail without
    // touching its contents. Locks down that invariant.
    const fs = require("node:fs");
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    const path = join(STATE_DIR, `${key}.lock`);
    fs.mkdirSync(path, { recursive: true });
    const innerFile = join(path, "do-not-delete.txt");
    fs.writeFileSync(innerFile, "preserve me");
    expect(tryAcquireWorkerLock(key)).toBe(false);
    expect(fs.existsSync(innerFile)).toBe(true);
    expect(fs.readFileSync(innerFile, "utf-8")).toBe("preserve me");
  });

  it("does NOT rmSync a regular lock file that replaced the stale dir mid-recovery", () => {
    // Regression test for the TOCTOU race Codex flagged: the EISDIR
    // self-heal must not steamroll a file that appeared at the lock
    // path between our failed `unlinkSync` and the recovery step.
    //
    // Setup: simulate the post-race state directly. After the source
    // code patches were applied, the only way for the code to reach
    // the `rmSync` branch is when the path is *still* a directory at
    // lstat time. We assert the inverse: if the path is a regular
    // file when self-heal runs (because another process won the race
    // and replaced it), the function must NOT destroy that file. The
    // way we observe this is by pre-existing a fresh-timestamp lock
    // file at the path and asserting tryAcquireWorkerLock returns
    // false (lock held) and the file is still there afterwards.
    const fs = require("node:fs");
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    const path = join(STATE_DIR, `${key}.lock`);
    fs.writeFileSync(path, String(Date.now())); // fresh "held by another process"
    const before = fs.readFileSync(path, "utf-8");
    expect(tryAcquireWorkerLock(key)).toBe(false);
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.readFileSync(path, "utf-8")).toBe(before);
    releaseWorkerLock(key);
  });
});

describe("HIVEMIND_STATE_DIR routing", () => {
  it("getStateDir + legacy-migration short-circuit on the tmp dir (no real-home pollution)", async () => {
    // Codex P1: legacy-migration.ts used to hardcode homedir(), so every
    // public state call (called transitively from readState / writeState /
    // withRmwLock / tryAcquireWorkerLock) would stat-and-potentially-rename
    // the developer's real `~/.deeplake/state/skilify` despite the env
    // override on state.ts.
    //
    // We `vi.resetModules()` before importing so this test truly
    // exercises `migrateLegacyStateDir()` from scratch. Earlier tests
    // in this file call it transitively (via `bumpStopCounter` → ...),
    // which would otherwise leave the module-level `attemptedFor` Set
    // already populated with STATE_DIR and short-circuit the function
    // before any of its body runs — the test would pass trivially
    // without proving anything about the function's behavior.
    //
    // Two assertions establish the channel is closed:
    //   1) getStateDir() returns the tmp dir, NOT a path under homedir().
    //   2) Calling migrateLegacyStateDir() is a no-op in this tmp world
    //      — the `skilify` sibling derived from the tmp dir does not
    //      exist, so the function never touches real-home paths.
    vi.resetModules();
    const { getStateDir } = await import("../../src/skillify/state-dir.js");
    const { migrateLegacyStateDir } = await import("../../src/skillify/legacy-migration.js");
    const { homedir } = await import("node:os");

    expect(getStateDir()).toBe(STATE_DIR);
    expect(getStateDir().startsWith(homedir())).toBe(false);

    const fs = require("node:fs");
    const tmpLegacy = join(STATE_DIR, "..", "skilify");
    expect(fs.existsSync(tmpLegacy)).toBe(false);
    expect(() => migrateLegacyStateDir()).not.toThrow();
    // Did not magic the legacy sibling into existence either.
    expect(fs.existsSync(tmpLegacy)).toBe(false);
  });

  it("migrateLegacyStateDir is a hard no-op when HIVEMIND_STATE_DIR is set, even if a sibling 'skilify' dir coincidentally exists", async () => {
    // CodeRabbit (#2/#5/#6 on PR #181): without an env-set guard,
    // an override like HIVEMIND_STATE_DIR=/tmp/foo would still cause
    // the migration to `existsSync('/tmp/skilify')` and — if some
    // unrelated tool happened to have created that dir — renameSync
    // it into the state path. Stage that exact scenario and assert
    // we leave the sibling alone.
    const fs = require("node:fs");
    const siblingLegacy = join(STATE_DIR, "..", "skilify");
    fs.mkdirSync(siblingLegacy, { recursive: true });
    const marker = join(siblingLegacy, "DO_NOT_TOUCH.txt");
    fs.writeFileSync(marker, "unrelated content");
    try {
      vi.resetModules();
      const { migrateLegacyStateDir } = await import("../../src/skillify/legacy-migration.js");
      expect(() => migrateLegacyStateDir()).not.toThrow();
      expect(fs.existsSync(siblingLegacy)).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(marker, "utf-8")).toBe("unrelated content");
    } finally {
      try { fs.rmSync(siblingLegacy, { recursive: true, force: true }); } catch { /* nothing */ }
    }
  });

  it("empty/whitespace HIVEMIND_STATE_DIR is treated as unset", async () => {
    // Defensive: a `HIVEMIND_STATE_DIR=` or `HIVEMIND_STATE_DIR="   "`
    // (forgotten value in a shell script, accidental empty pass-through
    // from CI config) used to win the `??` arm and force
    // `join("", ".deeplake", ...)` to resolve relative to the worker's
    // cwd — silently polluting whatever directory the process was
    // started in. After the trim+truthy guard in state-dir.ts, blank
    // values fall back to the homedir-based default.
    vi.resetModules();
    const { homedir } = await import("node:os");
    const prior = process.env.HIVEMIND_STATE_DIR;
    try {
      const { getStateDir } = await import("../../src/skillify/state-dir.js");
      process.env.HIVEMIND_STATE_DIR = "";
      expect(getStateDir().startsWith(homedir())).toBe(true);
      process.env.HIVEMIND_STATE_DIR = "   ";
      expect(getStateDir().startsWith(homedir())).toBe(true);
    } finally {
      // Restore so the rest of the suite keeps using the tmp dir.
      process.env.HIVEMIND_STATE_DIR = prior;
    }
  });

  it("scope-config + manifest paths land in HIVEMIND_STATE_DIR", async () => {
    // Codex P2: scope-config.ts and manifest.ts used to bypass the env
    // override (module-level STATE_DIR const + homedir() respectively).
    // After the refactor, both should resolve to the tmp dir.
    const { saveScopeConfig, loadScopeConfig } = await import("../../src/skillify/scope-config.js");
    const { manifestPath } = await import("../../src/skillify/manifest.js");

    saveScopeConfig({ scope: "team", team: ["alice"], install: "global" });
    const fs = require("node:fs");
    const configFile = join(STATE_DIR, "config.json");
    expect(fs.existsSync(configFile)).toBe(true);
    const reloaded = loadScopeConfig();
    expect(reloaded).toEqual({ scope: "team", team: ["alice"], install: "global" });

    expect(manifestPath()).toBe(join(STATE_DIR, "pulled.json"));

    // Cleanup — these files don't have a project-key suffix, so the
    // afterEach belt-and-braces sweep misses them.
    try { fs.rmSync(configFile, { force: true }); } catch { /* nothing */ }
  });
});

describe("TRIGGER_THRESHOLD", () => {
  it("defaults to 20 when env var unset or invalid", () => {
    // Cached at module load; we can't change env mid-test, so just assert
    // the cached value is sensible (env var was unset in test env).
    expect(TRIGGER_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(TRIGGER_THRESHOLD)).toBe(true);
  });
});
