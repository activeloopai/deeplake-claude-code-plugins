import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

/**
 * Functional tests for summary-state. The module computes STATE_DIR from
 * homedir() at module-load time, so we redirect $HOME to a tmp dir BEFORE
 * importing. Every test uses a unique session id so there is no cross-test
 * contamination.
 *
 * What these tests pin down:
 * - bumpTotalCount seeds fresh state and increments existing state
 * - shouldTrigger fires the first summary at 10 events, obeys msg/time
 *   cadence, and guards time-cadence with msgsSince > 0
 * - tryAcquireLock is mutually exclusive, reclaims stale locks, and rejects
 *   held locks
 * - finalizeSummary advances lastSummaryCount and preserves the highest
 *   observed totalCount
 * - loadTriggerConfig respects env overrides and falls back to defaults
 */

let tmpHome: string;
let mod: typeof import("../../src/hooks/summary-state.js");

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "summary-state-test-"));
  process.env.HOME = tmpHome;
  mod = await import("../../src/hooks/summary-state.js");
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const newSessionId = () => `test-${crypto.randomUUID()}`;

describe("bumpTotalCount", () => {
  it("seeds fresh state with totalCount=1 and lastSummaryCount=0", () => {
    const sid = newSessionId();
    const state = mod.bumpTotalCount(sid);
    expect(state.totalCount).toBe(1);
    expect(state.lastSummaryCount).toBe(0);
    expect(typeof state.lastSummaryAt).toBe("number");
  });

  it("increments existing totalCount and preserves lastSummaryAt/lastSummaryCount", () => {
    const sid = newSessionId();
    const first = mod.bumpTotalCount(sid);
    const second = mod.bumpTotalCount(sid);
    const third = mod.bumpTotalCount(sid);
    expect(second.totalCount).toBe(2);
    expect(third.totalCount).toBe(3);
    expect(second.lastSummaryAt).toBe(first.lastSummaryAt);
    expect(third.lastSummaryCount).toBe(0);
  });
});

describe("shouldTrigger", () => {
  const cfg = { everyNMessages: 50, everyHours: 2 };

  it("does NOT fire before 10 events on a fresh session", () => {
    const now = Date.now();
    for (let n = 1; n <= 9; n++) {
      expect(mod.shouldTrigger(
        { lastSummaryAt: now, lastSummaryCount: 0, totalCount: n }, cfg, now,
      )).toBe(false);
    }
  });

  it("fires the first summary at exactly 10 events", () => {
    const now = Date.now();
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 0, totalCount: 10 }, cfg, now,
    )).toBe(true);
  });

  it("fires when msgsSince reaches everyNMessages", () => {
    const now = Date.now();
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 10, totalCount: 59 }, cfg, now,
    )).toBe(false);
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 10, totalCount: 60 }, cfg, now,
    )).toBe(true);
  });

  it("fires when enough time has elapsed and there is at least one new event", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600 * 1000;
    expect(mod.shouldTrigger(
      { lastSummaryAt: twoHoursAgo, lastSummaryCount: 10, totalCount: 11 }, cfg, now,
    )).toBe(true);
  });

  it("does NOT fire on time alone when no new events have arrived", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600 * 1000;
    expect(mod.shouldTrigger(
      { lastSummaryAt: twoHoursAgo, lastSummaryCount: 42, totalCount: 42 }, cfg, now,
    )).toBe(false);
  });

  it("does NOT fire when below both thresholds", () => {
    const now = Date.now();
    expect(mod.shouldTrigger(
      { lastSummaryAt: now - 30 * 60 * 1000, lastSummaryCount: 10, totalCount: 30 }, cfg, now,
    )).toBe(false);
  });
});

describe("tryAcquireLock", () => {
  it("succeeds on a fresh session and blocks a second acquire", () => {
    const sid = newSessionId();
    expect(mod.tryAcquireLock(sid)).toBe(true);
    expect(mod.tryAcquireLock(sid)).toBe(false);
    mod.releaseLock(sid);
  });

  it("reclaims a stale lock past maxAge", () => {
    const sid = newSessionId();
    // Seed a stale lock file directly: timestamp well in the past.
    const p = mod.lockPath(sid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now() - 11 * 60 * 1000));
    // 10-minute default maxAge: the stale lock must be reclaimed.
    expect(mod.tryAcquireLock(sid)).toBe(true);
    mod.releaseLock(sid);
  });

  it("honors a fresh lock younger than maxAge", () => {
    const sid = newSessionId();
    expect(mod.tryAcquireLock(sid)).toBe(true);
    // Second acquire must fail — lock timestamp is ~now, well inside maxAge.
    expect(mod.tryAcquireLock(sid)).toBe(false);
    mod.releaseLock(sid);
  });

  it("releaseLock on a non-existent lock is a no-op", () => {
    const sid = newSessionId();
    expect(() => mod.releaseLock(sid)).not.toThrow();
  });

  it("treats an unreadable lock (non-numeric contents) as stale", () => {
    const sid = newSessionId();
    const p = mod.lockPath(sid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "garbage-not-a-number");
    expect(mod.tryAcquireLock(sid)).toBe(true);
    mod.releaseLock(sid);
  });
});

describe("finalizeSummary", () => {
  it("sets lastSummaryCount to the jsonl line count and advances lastSummaryAt", () => {
    const sid = newSessionId();
    mod.bumpTotalCount(sid);
    mod.bumpTotalCount(sid);
    const before = Date.now();
    mod.finalizeSummary(sid, 2);
    // Re-read: totalCount must be preserved (max of previous and jsonlLines)
    const s = JSON.parse(readFileSync(mod.statePath(sid), "utf-8"));
    expect(s.lastSummaryCount).toBe(2);
    expect(s.totalCount).toBe(2);
    expect(s.lastSummaryAt).toBeGreaterThanOrEqual(before);
  });

  it("preserves totalCount when jsonlLines is lower than totalCount", () => {
    const sid = newSessionId();
    for (let i = 0; i < 5; i++) mod.bumpTotalCount(sid);
    mod.finalizeSummary(sid, 3);
    const s = JSON.parse(readFileSync(mod.statePath(sid), "utf-8"));
    expect(s.lastSummaryCount).toBe(3);
    expect(s.totalCount).toBe(5);
  });

  it("handles missing prior state (no earlier bumpTotalCount)", () => {
    const sid = newSessionId();
    mod.finalizeSummary(sid, 4);
    const s = JSON.parse(readFileSync(mod.statePath(sid), "utf-8"));
    expect(s.lastSummaryCount).toBe(4);
    expect(s.totalCount).toBe(4);
  });
});

describe("loadTriggerConfig", () => {
  const origN = process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS;
  const origH = process.env.HIVEMIND_SUMMARY_EVERY_HOURS;

  beforeEach(() => {
    delete process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS;
    delete process.env.HIVEMIND_SUMMARY_EVERY_HOURS;
  });

  afterAll(() => {
    if (origN !== undefined) process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS = origN;
    if (origH !== undefined) process.env.HIVEMIND_SUMMARY_EVERY_HOURS = origH;
  });

  it("falls back to defaults when env vars are unset", () => {
    const cfg = mod.loadTriggerConfig();
    expect(cfg.everyNMessages).toBe(50);
    expect(cfg.everyHours).toBe(2);
  });

  it("respects valid env overrides", () => {
    process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS = "30";
    process.env.HIVEMIND_SUMMARY_EVERY_HOURS = "1";
    const cfg = mod.loadTriggerConfig();
    expect(cfg.everyNMessages).toBe(30);
    expect(cfg.everyHours).toBe(1);
  });

  it("ignores invalid values and uses defaults", () => {
    process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS = "not-a-number";
    process.env.HIVEMIND_SUMMARY_EVERY_HOURS = "-5";
    const cfg = mod.loadTriggerConfig();
    expect(cfg.everyNMessages).toBe(50);
    expect(cfg.everyHours).toBe(2);
  });

  it("accepts fractional hours", () => {
    process.env.HIVEMIND_SUMMARY_EVERY_HOURS = "0.5";
    const cfg = mod.loadTriggerConfig();
    expect(cfg.everyHours).toBe(0.5);
  });
});

describe("state files live under $HOME/.claude/hooks/summary-state/", () => {
  it("writeState creates the directory and writes JSON", () => {
    const sid = newSessionId();
    mod.bumpTotalCount(sid);
    const expected = join(tmpHome, ".claude", "hooks", "summary-state", `${sid}.json`);
    expect(existsSync(expected)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Edge-case and integration tests — these pin down the full periodic-summary
// state machine and the bounds that the capture hook relies on.
// ══════════════════════════════════════════════════════════════════════════════

describe("shouldTrigger — boundary conditions", () => {
  const cfg = { everyNMessages: 50, everyHours: 2 };

  it("first-summary rule only applies while lastSummaryCount is 0", () => {
    const now = Date.now();
    // lastSummaryCount > 0 means the first-summary path is no longer active:
    // totalCount=15 with lastSummaryCount=10 is 5 new messages, well below 50.
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 10, totalCount: 15 }, cfg, now,
    )).toBe(false);
  });

  it("time trigger fires exactly at the cadence boundary", () => {
    const now = Date.now();
    const twoHoursExact = now - 2 * 3600 * 1000;
    expect(mod.shouldTrigger(
      { lastSummaryAt: twoHoursExact, lastSummaryCount: 10, totalCount: 11 }, cfg, now,
    )).toBe(true);
  });

  it("time trigger does NOT fire just below the cadence boundary", () => {
    const now = Date.now();
    const justUnder = now - (2 * 3600 * 1000 - 1);
    expect(mod.shouldTrigger(
      { lastSummaryAt: justUnder, lastSummaryCount: 10, totalCount: 11 }, cfg, now,
    )).toBe(false);
  });

  it("msg trigger respects custom everyNMessages", () => {
    const now = Date.now();
    const tightCfg = { everyNMessages: 3, everyHours: 999 };
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 10, totalCount: 12 }, tightCfg, now,
    )).toBe(false);
    expect(mod.shouldTrigger(
      { lastSummaryAt: now, lastSummaryCount: 10, totalCount: 13 }, tightCfg, now,
    )).toBe(true);
  });
});

describe("tryAcquireLock — age boundaries and custom maxAge", () => {
  it("honors a custom maxAgeMs (short TTL reclaims quickly)", async () => {
    const sid = newSessionId();
    expect(mod.tryAcquireLock(sid, 50)).toBe(true);
    // With 50ms TTL, sleep past the window and try again from a "new process"
    await new Promise(r => setTimeout(r, 80));
    // The existing lock must now look stale even though the current process
    // holds it — a separate caller (simulated here) would reclaim it.
    expect(mod.tryAcquireLock(sid, 50)).toBe(true);
    mod.releaseLock(sid);
  });

  it("a lock timestamp of exactly Date.now() is considered fresh", () => {
    const sid = newSessionId();
    const p = mod.lockPath(sid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now()));
    expect(mod.tryAcquireLock(sid)).toBe(false);
    try { rmSync(p); } catch { /* ignore */ }
  });

  it("a lock timestamp from the future (clock skew) is treated as fresh", () => {
    const sid = newSessionId();
    const p = mod.lockPath(sid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now() + 60_000));
    // ageMs is negative (< maxAgeMs), so the lock is held.
    expect(mod.tryAcquireLock(sid)).toBe(false);
    try { rmSync(p); } catch { /* ignore */ }
  });
});

describe("full periodic-summary cycle", () => {
  it("bump → trigger → acquire → finalize → next bump no longer triggers", () => {
    const sid = newSessionId();
    const cfg = { everyNMessages: 50, everyHours: 24 };

    // Bump 9 times — first-summary threshold is 10, so nothing yet.
    for (let i = 0; i < 9; i++) {
      const s = mod.bumpTotalCount(sid);
      expect(mod.shouldTrigger(s, cfg)).toBe(false);
    }

    // 10th bump crosses the first-summary threshold.
    const tenth = mod.bumpTotalCount(sid);
    expect(tenth.totalCount).toBe(10);
    expect(mod.shouldTrigger(tenth, cfg)).toBe(true);

    // Acquire the lock so the capture hook would spawn exactly one worker.
    expect(mod.tryAcquireLock(sid)).toBe(true);
    // A second capture within the same window cannot acquire — this is what
    // prevents duplicate workers when events arrive in quick succession.
    expect(mod.tryAcquireLock(sid)).toBe(false);

    // Worker finishes: finalize + release.
    mod.finalizeSummary(sid, 10);
    mod.releaseLock(sid);

    // Next bump: lastSummaryCount is now 10, msgsSince=1, well below 50.
    const eleventh = mod.bumpTotalCount(sid);
    expect(eleventh.lastSummaryCount).toBe(10);
    expect(eleventh.totalCount).toBe(11);
    expect(mod.shouldTrigger(eleventh, cfg)).toBe(false);
  });

  it("second summary fires after everyNMessages messages past lastSummaryCount", () => {
    const sid = newSessionId();
    const cfg = { everyNMessages: 50, everyHours: 24 };

    // Fast-forward state as if a first summary already landed at 10.
    for (let i = 0; i < 10; i++) mod.bumpTotalCount(sid);
    mod.finalizeSummary(sid, 10);

    // Bump 49 more times: msgsSince=49, still below 50.
    for (let i = 0; i < 49; i++) {
      const s = mod.bumpTotalCount(sid);
      expect(mod.shouldTrigger(s, cfg)).toBe(false);
    }

    // 50th bump past lastSummaryCount triggers.
    const trigger = mod.bumpTotalCount(sid);
    expect(trigger.totalCount).toBe(60);
    expect(mod.shouldTrigger(trigger, cfg)).toBe(true);
  });

  it("releaseLock is idempotent across calls", () => {
    const sid = newSessionId();
    mod.tryAcquireLock(sid);
    mod.releaseLock(sid);
    expect(() => mod.releaseLock(sid)).not.toThrow();
    expect(() => mod.releaseLock(sid)).not.toThrow();
    // After release, a fresh acquire must succeed again.
    expect(mod.tryAcquireLock(sid)).toBe(true);
    mod.releaseLock(sid);
  });
});

describe("cross-process concurrency", () => {
  // Each subprocess imports summary-state with the same $HOME + a sessionId
  // passed via env var. The file-based RMW lock is the ONLY thing preventing
  // lost updates (bumpTotalCount) and preventing multiple winners
  // (tryAcquireLock) across processes, so these tests are a real stress test
  // of the lock. Session id comes via env (TEST_SID) because tsx's `-e` flag
  // does not forward positional args reliably across node versions.
  const modPath = new URL("../../src/hooks/summary-state.ts", import.meta.url).pathname;

  const runParallel = async (code: string, N: number, sid: string): Promise<string[]> => {
    const runs = Array.from({ length: N }, () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn("npx", ["tsx", "-e", code], {
          env: { ...process.env, HOME: tmpHome, TEST_SID: sid },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.on("exit", (c: number | null) => c === 0 ? resolve(out) : reject(new Error(`exit ${c}`)));
        child.on("error", reject);
      }),
    );
    return Promise.all(runs);
  };

  it("N parallel subprocesses each bump once and the total equals N", async () => {
    const sid = newSessionId();
    const N = 8;
    const code =
      `import("${modPath}").then(m => { ` +
      `  const s = m.bumpTotalCount(process.env.TEST_SID); ` +
      `  process.stdout.write(String(s.totalCount)); ` +
      `});`;

    await runParallel(code, N, sid);

    const finalState = JSON.parse(readFileSync(mod.statePath(sid), "utf-8"));
    expect(finalState.totalCount).toBe(N);
  }, 30_000);

  it("N parallel subprocesses racing on tryAcquireLock — exactly one wins", async () => {
    const sid = newSessionId();
    const N = 8;
    const code =
      `import("${modPath}").then(m => { ` +
      `  process.stdout.write(m.tryAcquireLock(process.env.TEST_SID) ? "1" : "0"); ` +
      `});`;

    const results = await runParallel(code, N, sid);
    const winners = results.filter(r => r === "1").length;
    expect(winners).toBe(1);
    mod.releaseLock(sid);
  }, 30_000);
});
