import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Mock the spawn helper so triggers don't actually fork a worker subprocess.
const spawnCalls: any[] = [];
let spawnShouldThrow = false;
vi.mock("../../src/skillify/spawn-skillify-worker.js", () => ({
  spawnSkillifyWorker: (opts: any) => {
    if (spawnShouldThrow) throw new Error("synthetic spawn failure");
    spawnCalls.push(opts);
  },
  skillifyLog: () => { /* no-op for tests */ },
  bundleDirFromImportMeta: (url: string) => url,
}));

// Import AFTER vi.mock so the mock is in place.
import { tryStopCounterTrigger, forceSessionEndTrigger } from "../../src/skillify/triggers.js";
import {
  deriveProjectKey,
  bumpStopCounter,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  readState,
  TRIGGER_THRESHOLD,
} from "../../src/skillify/state.js";

const STATE_DIR = join(homedir(), ".deeplake", "state", "skillify");
let tracked: string[] = [];

beforeEach(() => {
  spawnCalls.length = 0;
  spawnShouldThrow = false;
  tracked = [];
});

afterEach(() => {
  for (const key of tracked) {
    for (const ext of [".json", ".lock", ".lock.rmw"]) {
      try { rmSync(join(STATE_DIR, `${key}${ext}`)); } catch { /* nothing */ }
    }
  }
  delete process.env.HIVEMIND_SKILLIFY_WORKER;
});

function freshCwd(): string { return `/tmp/skillify-trig-${randomUUID()}`; }
function track(key: string): string { tracked.push(key); return key; }

const fakeOpts = (cwd: string, agent = "claude_code") => ({
  config: { token: "x", apiUrl: "x", orgId: "x", workspaceId: "x" } as any,
  cwd,
  bundleDir: "/bundle",
  agent,
  sessionId: "session-1",
});

// ── tryStopCounterTrigger ──────────────────────────────────────────────────

describe("tryStopCounterTrigger", () => {
  it("returns immediately when HIVEMIND_SKILLIFY_WORKER=1 (recursion guard)", () => {
    process.env.HIVEMIND_SKILLIFY_WORKER = "1";
    tryStopCounterTrigger(fakeOpts(freshCwd()));
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns immediately when cwd is empty", () => {
    tryStopCounterTrigger(fakeOpts(""));
    expect(spawnCalls).toHaveLength(0);
  });

  it("does NOT fire when counter is below threshold", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    // bump once — way below threshold
    tryStopCounterTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(0);
  });

  it("fires the worker when counter reaches the threshold", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    // pre-bump to threshold-1 so the next trigger crosses
    for (let i = 1; i < TRIGGER_THRESHOLD; i++) bumpStopCounter(cwd);
    tryStopCounterTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].agent).toBe("claude_code");
    expect(spawnCalls[0].cwd).toBe(cwd);
    expect(spawnCalls[0].reason).toBe("Stop");
  });

  it("does NOT fire when worker lock is held by another process", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    for (let i = 1; i < TRIGGER_THRESHOLD; i++) bumpStopCounter(cwd);
    // Hold the lock externally
    expect(tryAcquireWorkerLock(key)).toBe(true);
    tryStopCounterTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(0);
    releaseWorkerLock(key);
  });

  it("releases the lock when spawn throws (so a future trigger can retry)", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    for (let i = 1; i < TRIGGER_THRESHOLD; i++) bumpStopCounter(cwd);
    spawnShouldThrow = true;
    tryStopCounterTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(0);
    // Lock should be released — verify by acquiring it
    expect(tryAcquireWorkerLock(key)).toBe(true);
    releaseWorkerLock(key);
  });
});

// ── forceSessionEndTrigger ─────────────────────────────────────────────────

describe("forceSessionEndTrigger", () => {
  it("returns immediately when HIVEMIND_SKILLIFY_WORKER=1", () => {
    process.env.HIVEMIND_SKILLIFY_WORKER = "1";
    forceSessionEndTrigger(fakeOpts(freshCwd()));
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns immediately when cwd is empty", () => {
    forceSessionEndTrigger(fakeOpts(""));
    expect(spawnCalls).toHaveLength(0);
  });

  it("ALWAYS fires the worker when cwd is set (no counter check)", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    forceSessionEndTrigger(fakeOpts(cwd, "codex"));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].agent).toBe("codex");
    expect(spawnCalls[0].reason).toBe("SessionEnd");
  });

  it("does NOT fire when worker lock is already held", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    expect(tryAcquireWorkerLock(key)).toBe(true);
    forceSessionEndTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(0);
    releaseWorkerLock(key);
  });

  it("releases the lock when spawn throws", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    spawnShouldThrow = true;
    forceSessionEndTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(0);
    expect(tryAcquireWorkerLock(key)).toBe(true);
    releaseWorkerLock(key);
  });

  it("resets the counter when state exists (so Stop trigger doesn't double-fire)", () => {
    const cwd = freshCwd();
    const { key } = deriveProjectKey(cwd);
    track(key);
    bumpStopCounter(cwd);
    bumpStopCounter(cwd);
    bumpStopCounter(cwd);
    forceSessionEndTrigger(fakeOpts(cwd));
    expect(spawnCalls).toHaveLength(1);
    // After fire, counter is reset
    const state = readState(key);
    expect(state?.counter).toBe(0);
  });
});
