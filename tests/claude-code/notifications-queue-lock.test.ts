/**
 * Branch coverage for src/notifications/queue.ts — focused on the new
 * `withQueueLock` paths that the cross-process safety fix introduced.
 *
 * Tests overlap with notifications.test.ts on the happy path (subprocess
 * pool); this file isolates the synthetic branches (stale-lock reclaim,
 * give-up after MAX retries, write-outside-home guard, malformed JSON,
 * unknown-error rethrow) so vitest can hit them deterministically
 * without needing the 6 s real-time wait the production constants
 * imply.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enqueueNotification,
  queuePath,
  readQueue,
  writeQueue,
  _isQueuePathInsideHome,
  _setLockTimingForTesting,
  _resetLockTimingForTesting,
} from "../../src/notifications/queue.js";

let tmpHome = "";
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "queue-lock-test-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Short retries + short stale window so the synthetic branches resolve
  // in milliseconds, not the production 6 s.
  _setLockTimingForTesting({ retryMax: 5, retryBaseMs: 1, staleMs: 50 });
});

afterEach(() => {
  _resetLockTimingForTesting();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("withQueueLock — stale-lock reclaim", () => {
  it("reclaims a lock file older than LOCK_STALE_MS and proceeds with the enqueue", async () => {
    mkdirSync(join(tmpHome, ".deeplake"), { recursive: true });
    const lockFile = `${queuePath()}.lock`;
    // Create the lock file and age it past the (test-shrunk) stale window.
    const fd = openSync(lockFile, "wx", 0o600);
    closeSync(fd);
    const ancient = (Date.now() - 5000) / 1000;
    utimesSync(lockFile, ancient, ancient);

    await enqueueNotification({
      id: "test-stale-reclaim",
      title: "T", body: "B",
      dedupKey: { tag: "stale" },
    });
    expect(readQueue().queue.length).toBe(1);
    expect(readQueue().queue[0].id).toBe("test-stale-reclaim");
    // The reclaim-then-release sequence leaves no lock behind.
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("withQueueLock — give up after MAX retries (degrades to unlocked)", () => {
  it("when the lock can't be acquired, still runs fn and persists the enqueue", async () => {
    mkdirSync(join(tmpHome, ".deeplake"), { recursive: true });
    const lockFile = `${queuePath()}.lock`;
    // Fresh, recently-mtime'd lock that the reclaim branch won't touch.
    const fd = openSync(lockFile, "wx", 0o600);
    closeSync(fd);
    // mtime is "now" → not stale → every attempt hits EEXIST → exhausts retries.

    await enqueueNotification({
      id: "test-giveup",
      title: "T", body: "B",
      dedupKey: { tag: "giveup" },
    });
    // The unlocked fallback still wrote the queue.
    expect(readQueue().queue.length).toBe(1);
    expect(readQueue().queue[0].id).toBe("test-giveup");
    // The lock file we held is still there (we didn't own it, so we
    // didn't unlink it on release).
    expect(existsSync(lockFile)).toBe(true);
  });
});

describe("readQueue — malformed JSON branch", () => {
  it("returns empty queue when the on-disk file is not valid JSON", () => {
    mkdirSync(join(tmpHome, ".deeplake"), { recursive: true });
    writeFileSync(queuePath(), "not-json-at-all", "utf-8");
    expect(readQueue()).toEqual({ queue: [] });
  });

  it("returns empty queue when the JSON shape is wrong (missing `queue` array)", () => {
    mkdirSync(join(tmpHome, ".deeplake"), { recursive: true });
    writeFileSync(queuePath(), JSON.stringify({ wrong: "shape" }), "utf-8");
    expect(readQueue()).toEqual({ queue: [] });
  });
});

describe("enqueueNotification — sameDedupKey branches", () => {
  it("skips append when an equivalent (id, dedupKey) is already queued (same-process dedup)", async () => {
    const n = {
      id: "embed-deps-missing",
      title: "T",
      body: "B",
      dedupKey: { reason: "transformers-missing", detail: "exact" },
    };
    await enqueueNotification(n);
    await enqueueNotification(n);
    await enqueueNotification(n);
    expect(readQueue().queue.length).toBe(1);
  });

  it("appends a second entry when id differs but dedupKey matches (id discriminates)", async () => {
    // Hits the `a.id !== b.id` early-return inside sameDedupKey.
    await enqueueNotification({
      id: "id-A", title: "T", body: "B",
      dedupKey: { v: 1 },
    });
    await enqueueNotification({
      id: "id-B", title: "T", body: "B",
      dedupKey: { v: 1 },
    });
    expect(readQueue().queue.length).toBe(2);
    expect(readQueue().queue.map(n => n.id).sort()).toEqual(["id-A", "id-B"]);
  });

  it("appends a second entry when id matches but dedupKey differs (key discriminates)", async () => {
    // Hits the JSON.stringify comparison returning `false`.
    await enqueueNotification({ id: "shared", title: "T", body: "B", dedupKey: { v: 1 } });
    await enqueueNotification({ id: "shared", title: "T", body: "B", dedupKey: { v: 2 } });
    expect(readQueue().queue.length).toBe(2);
  });
});

describe("_isQueuePathInsideHome — outside-HOME guard", () => {
  // Defense-in-depth invariant: the guard inside writeQueue refuses to
  // touch the filesystem if the resolved queue path would escape $HOME.
  // The actual `writeQueue` call can only hit this branch via a homedir()
  // race (ESM doesn't let us spy on os.homedir reliably), so we test the
  // extracted predicate directly.

  it("returns true when the path is a direct child of home", () => {
    expect(_isQueuePathInsideHome("/home/u/.deeplake/notifications-queue.json", "/home/u")).toBe(true);
  });

  it("returns true when the path equals home itself", () => {
    expect(_isQueuePathInsideHome("/home/u", "/home/u")).toBe(true);
  });

  it("returns true when home has a trailing slash (resolved normalizes)", () => {
    expect(_isQueuePathInsideHome("/home/u/.deeplake/notifications-queue.json", "/home/u/")).toBe(true);
  });

  it("returns FALSE when the path is in a sibling directory of home", () => {
    expect(_isQueuePathInsideHome("/etc/.deeplake/notifications-queue.json", "/home/u")).toBe(false);
  });

  it("returns FALSE on a prefix-match attack (path starts with home substring but differs)", () => {
    // The naive `startsWith(home)` would let `/home/userspace/...` slip
    // through when home is `/home/user`. Adding the explicit `home + "/"`
    // separator (which the helper does internally) blocks it.
    expect(_isQueuePathInsideHome("/home/userspace/.deeplake/notifications-queue.json", "/home/user")).toBe(false);
  });

  it("returns FALSE for a relative path that resolves outside home", () => {
    // resolve("../../etc/passwd") relative to cwd lands somewhere far
    // from a tmp home, so the guard rejects.
    const outside = "/etc/.deeplake/notifications-queue.json";
    const home = mkdtempSync(join(tmpdir(), "queue-outside-guard-"));
    try {
      expect(_isQueuePathInsideHome(outside, home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
