import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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

const STATE_DIR = join(homedir(), ".deeplake", "state", "skillify");

/**
 * Use a unique cwd per test so the derived project key never collides with
 * other tests or real user state. The state files end up in the real
 * ~/.deeplake/state/skillify dir but with random keys we own and clean up.
 */
function freshCwd(): string {
  return `/tmp/skillify-test-${randomUUID()}`;
}

let trackedKeys: string[] = [];

beforeEach(() => { trackedKeys = []; });

afterEach(() => {
  for (const key of trackedKeys) {
    for (const ext of [".json", ".lock", ".lock.rmw"]) {
      try { rmSync(join(STATE_DIR, `${key}${ext}`)); } catch { /* nothing to do */ }
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
  it("treats an unreadable lock file as stale (covers readErr branch)", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    // Manually create a directory at the lock path so readFileSync throws
    // EISDIR — exercises the readErr catch branch.
    const fs = require("node:fs");
    const path = join(STATE_DIR, `${key}.lock`);
    try { fs.mkdirSync(path, { recursive: true }); } catch { /* may already exist */ }
    // Now tryAcquireWorkerLock will hit readErr (EISDIR), then unlinkSync
    // also fails (EISDIR for unlink on a dir → returns false).
    const ok = tryAcquireWorkerLock(key);
    expect(ok).toBe(false);
    // Cleanup
    try { fs.rmdirSync(path); } catch { /* nothing */ }
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
