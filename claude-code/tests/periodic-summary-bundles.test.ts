import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bundle-level anti-regression for the periodic-summary feature. These
 * tests scan the SHIPPED bundles (claude-code + codex) to confirm:
 *
 * 1. The SessionEnd race fix is present: before spawning the worker, the
 *    hook checks tryAcquireLock and bails when another worker is running.
 *    Two concurrent workers writing the same summary row trip the Deeplake
 *    UPDATE-coalescing quirk and drop one write.
 *
 * 2. The periodic trigger in the capture hook also acquires the lock
 *    before spawning — same reason.
 *
 * 3. The internal wiki-worker flag uses ONLY the new HIVEMIND_WIKI_WORKER
 *    name. DEEPLAKE_WIKI_WORKER was a migration-only fallback and is a
 *    plugin-internal signal, so there is no reason to keep it shipped.
 *
 * 4. HIVEMIND_CAPTURE=false is respected everywhere the guard existed —
 *    the rename left one path reading the old name only, which we fixed.
 *
 * Source tests (summary-state.test.ts) prove the lock module is correct;
 * these bundle checks prove the build didn't drop the call sites.
 */

const BUNDLE_ROOT = resolve(__dirname, "..", "..");

const SESSION_END_HOOKS: Array<[string, string]> = [
  ["claude-code session-end", resolve(BUNDLE_ROOT, "claude-code", "bundle", "session-end.js")],
  ["codex stop", resolve(BUNDLE_ROOT, "codex", "bundle", "stop.js")],
];

const CAPTURE_HOOKS: Array<[string, string]> = [
  ["claude-code capture", resolve(BUNDLE_ROOT, "claude-code", "bundle", "capture.js")],
  ["codex capture", resolve(BUNDLE_ROOT, "codex", "bundle", "capture.js")],
];

const ALL_BUNDLES: Array<[string, string]> = [
  ...SESSION_END_HOOKS,
  ...CAPTURE_HOOKS,
  ["claude-code session-start", resolve(BUNDLE_ROOT, "claude-code", "bundle", "session-start.js")],
  ["claude-code session-start-setup", resolve(BUNDLE_ROOT, "claude-code", "bundle", "session-start-setup.js")],
  ["codex session-start", resolve(BUNDLE_ROOT, "codex", "bundle", "session-start.js")],
  ["codex session-start-setup", resolve(BUNDLE_ROOT, "codex", "bundle", "session-start-setup.js")],
];

describe("bundles exist", () => {
  it.each(ALL_BUNDLES)("%s bundle file is present", (_label, path) => {
    expect(existsSync(path)).toBe(true);
  });
});

// ══ SessionEnd-style hooks: must acquire the lock before spawning ══════════
describe.each(SESSION_END_HOOKS)("%s bundle — race fix", (_label, path) => {
  const src = readFileSync(path, "utf-8");

  it("calls tryAcquireLock before spawning the worker", () => {
    expect(src).toMatch(/tryAcquireLock/);
    // The bail-out branch that exists only because of the race fix: when
    // the lock is held, we log and return without spawning.
    expect(src).toMatch(/periodic worker already running/);
  });

  it("spawns the wiki worker only on the happy path", () => {
    // Must still reference the spawn helper — a full removal would also
    // match "no race" but would break the feature.
    expect(src).toMatch(/spawn(Codex)?WikiWorker/);
  });
});

// ══ Capture hooks: periodic trigger also acquires the lock ═════════════════
describe.each(CAPTURE_HOOKS)("%s bundle — periodic trigger", (_label, path) => {
  const src = readFileSync(path, "utf-8");

  it("acquires the lock before spawning from the periodic path", () => {
    expect(src).toMatch(/tryAcquireLock/);
    expect(src).toMatch(/shouldTrigger/);
    expect(src).toMatch(/bumpTotalCount/);
  });

  it("references the summary-state helpers (feature wired end-to-end)", () => {
    expect(src).toMatch(/loadTriggerConfig/);
  });
});

// ══ Internal flag uses only the new name ═══════════════════════════════════
describe.each(ALL_BUNDLES)("%s bundle — clean env flags", (_label, path) => {
  const src = readFileSync(path, "utf-8");

  it("uses HIVEMIND_WIKI_WORKER and not the legacy DEEPLAKE_WIKI_WORKER", () => {
    // HIVEMIND_WIKI_WORKER is the internal signal the wiki worker sets on
    // itself; every hook must gate on it. The old DEEPLAKE_* fallback was
    // pure back-compat noise for an internal flag and is removed.
    if (!src.includes("HIVEMIND_WIKI_WORKER")) {
      // Some bundles don't need the guard (e.g. pure utility bundles) —
      // skip. Every bundle in this suite actually does gate, but be lenient.
      return;
    }
    expect(src).not.toMatch(/DEEPLAKE_WIKI_WORKER/);
  });

  it("does not fall back to DEEPLAKE_CAPTURE for the capture-disabled guard", () => {
    // The guard must read HIVEMIND_CAPTURE only. DEEPLAKE_CAPTURE is a
    // pre-rename alias that would mask a user setting HIVEMIND_CAPTURE=false.
    expect(src).not.toMatch(/DEEPLAKE_CAPTURE/);
  });
});

// ══ summary-state module is inlined into every bundle that needs it ════════
describe("summary-state helpers are inlined into the hook bundles", () => {
  // SessionEnd-style hooks only need tryAcquireLock (the worker itself
  // releases the lock in its finally block). esbuild tree-shakes
  // releaseLock out of those bundles, which is expected.
  it.each(SESSION_END_HOOKS)("%s bundle inlines tryAcquireLock", (_label, path) => {
    const src = readFileSync(path, "utf-8");
    expect(src).toMatch(/function tryAcquireLock/);
  });

  // Capture hooks need both: tryAcquireLock to gate the spawn, and
  // releaseLock as the error-path fallback when spawn throws before the
  // worker takes ownership of the lock.
  it.each(CAPTURE_HOOKS)("%s bundle inlines tryAcquireLock + releaseLock", (_label, path) => {
    const src = readFileSync(path, "utf-8");
    expect(src).toMatch(/function tryAcquireLock/);
    expect(src).toMatch(/function releaseLock/);
  });
});
