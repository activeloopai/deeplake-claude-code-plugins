/**
 * Tests for src/skillify/auto-pull.ts.
 *
 * Mocks at the network seam — the real `runPull` runs end-to-end against an
 * injected QueryFn that returns canned rows. Filesystem effects are scoped
 * to a temp dir via HOME override, so tests don't pollute ~/.deeplake or
 * ~/.claude on the developer's machine.
 *
 * Coverage targets per vitest.config.ts (90% lines / 90% functions /
 * 70% branches for src/skillify/auto-pull.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub DeeplakeApi at module load — the no-queryFn path inside autoPullSkills
// constructs one and calls .query(sql). Without this, that branch (and its
// internal SQL-wrapping lambda) is uncoverable in tests, dropping the file's
// function-coverage below the configured 90% threshold.
const apiQueryMock = vi.fn();
vi.mock("../../src/deeplake-api.js", () => ({
  // Class form is required because the source code uses `new DeeplakeApi(...)`.
  // `vi.fn().mockImplementation(arrow)` won't work as a constructor.
  DeeplakeApi: class {
    query(sql: string) { return apiQueryMock(sql); }
  },
}));

import { autoPullSkills } from "../../src/skillify/auto-pull.js";
import type { QueryFn } from "../../src/skillify/pull.js";
import type { Config } from "../../src/config.js";

// ─── Test harness ──────────────────────────────────────────────────────────────
// We pin HOME to a per-test temp dir so any file writes land in the sandbox
// instead of the user's real ~/.deeplake. Same trick the rest of the skillify
// suite uses.

let tmpHome: string;
const realHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "autopull-"));
  process.env.HOME = tmpHome;
  delete process.env.HIVEMIND_AUTOPULL_DISABLED;
  apiQueryMock.mockReset();
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.HIVEMIND_AUTOPULL_DISABLED;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* nothing */ }
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    token: "tok",
    orgId: "org",
    orgName: "OrgName",
    userName: "user",
    workspaceId: "default",
    apiUrl: "https://api.deeplake.ai",
    tableName: "memory",
    sessionsTableName: "sessions",
    skillsTableName: "skills",
    memoryPath: join(tmpHome, ".deeplake", "memory"),
  };
}

function sampleRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "shared-skill",
    project: "p",
    project_key: "pk1",
    body: "## Workflow\n\nDo the thing.",
    version: 1,
    source_agent: "claude_code",
    scope: "org",
    author: "alice",
    description: "Shared skill",
    trigger_text: "When sharing",
    source_sessions: '["s1"]',
    install: "global",
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...over,
  };
}

function makeMockQuery(rows: Record<string, unknown>[]): { fn: QueryFn; calls: string[] } {
  const calls: string[] = [];
  const fn: QueryFn = async (sql: string) => { calls.push(sql); return rows; };
  return { fn, calls };
}

// ─── autoPullSkills — env-based skips ──────────────────────────────────────────

describe("autoPullSkills — disabled paths", () => {
  it("skips when HIVEMIND_AUTOPULL_DISABLED=1 (no config / query touched)", async () => {
    process.env.HIVEMIND_AUTOPULL_DISABLED = "1";
    const loadConfigFn = vi.fn(() => makeConfig());
    const { fn: queryFn, calls } = makeMockQuery([]);
    const result = await autoPullSkills({ loadConfigFn, queryFn });
    expect(result).toEqual({ pulled: 0, skipped: true, reason: "disabled" });
    // Short-circuit: env-disabled must not even reach loadConfig.
    expect(loadConfigFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

// ─── autoPullSkills — not-logged-in ────────────────────────────────────────────

describe("autoPullSkills — not logged in", () => {
  it("returns silently when loadConfig returns null (no nag)", async () => {
    const loadConfigFn = vi.fn(() => null);
    const { fn: queryFn, calls } = makeMockQuery([]);
    const result = await autoPullSkills({ loadConfigFn, queryFn });
    expect(result).toEqual({ pulled: 0, skipped: true, reason: "not-logged-in" });
    expect(loadConfigFn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

// ─── autoPullSkills — happy path runs every call (no throttle) ─────────────────

describe("autoPullSkills — runs every call", () => {
  it("first call runs the pull and writes SKILL.md", async () => {
    const loadConfigFn = () => makeConfig();
    const { fn: queryFn, calls } = makeMockQuery([sampleRow()]);
    const result = await autoPullSkills({
      loadConfigFn, queryFn, install: "project", cwd: tmpHome,
    });
    expect(result.skipped).toBe(false);
    expect(result.pulled).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`FROM "skills"`);
    expect(calls[0]).not.toMatch(/WHERE/);          // users=[] → no author filter
    // Pulled skills land at <root>/<name>--<author>/SKILL.md (see src/skillify/pull.ts:330).
    expect(existsSync(join(tmpHome, ".claude/skills/shared-skill--alice/SKILL.md"))).toBe(true);
  });

  it("second call also runs (no throttle window — file writes idempotent inside runPull)", async () => {
    // Regression guard for the throttle removal: previously the second
    // call within 30 minutes would skip with reason="throttled". Now it
    // must always reach runPull. The expensive part (network query)
    // happens both times; the cheap part (file writes) idempotently
    // skips up-to-date skills inside runPull itself.
    const loadConfigFn = () => makeConfig();
    const { fn: queryFn, calls } = makeMockQuery([sampleRow()]);

    const r1 = await autoPullSkills({ loadConfigFn, queryFn, install: "project", cwd: tmpHome });
    expect(r1.skipped).toBe(false);
    expect(calls).toHaveLength(1);

    const r2 = await autoPullSkills({ loadConfigFn, queryFn, install: "project", cwd: tmpHome });
    // skipped:false even though SKILL.md is up-to-date — the auto-pull
    // ran the query end-to-end. wrote=0 because runPull's decideAction
    // returned "skipped" for the now-unchanged row.
    expect(r2.skipped).toBe(false);
    expect(r2.pulled).toBe(0);
    expect(calls).toHaveLength(2);
  });
});

// ─── autoPullSkills — failure handling ─────────────────────────────────────────

describe("autoPullSkills — failures swallowed", () => {
  it("does NOT throw when query fails", async () => {
    const loadConfigFn = () => makeConfig();
    const failingQuery: QueryFn = async () => { throw new Error("network borked"); };
    const result = await autoPullSkills({
      loadConfigFn, queryFn: failingQuery, install: "project", cwd: tmpHome,
    });
    expect(result).toEqual({ pulled: 0, skipped: true, reason: "error" });
  });

  it("treats 'table does not exist' as empty result (zero-write success)", async () => {
    // runPull's isMissingTableError swallows this and returns scanned=0.
    // autoPullSkills then treats it as a successful zero-write pull.
    const loadConfigFn = () => makeConfig();
    const tableMissingQuery: QueryFn = async () => {
      throw new Error('relation "skills" does not exist');
    };
    const result = await autoPullSkills({
      loadConfigFn, queryFn: tableMissingQuery, install: "project", cwd: tmpHome,
    });
    expect(result.skipped).toBe(false);
    expect(result.pulled).toBe(0);
  });

  it("times out a hanging query without freezing", async () => {
    const loadConfigFn = () => makeConfig();
    // Query never resolves — would hang forever without the timeout.
    const hangingQuery: QueryFn = () => new Promise(() => { /* never */ });
    const start = Date.now();
    const result = await autoPullSkills({
      loadConfigFn, queryFn: hangingQuery, install: "project", cwd: tmpHome,
      timeoutMs: 100,                                  // tiny timeout for the test
    });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ pulled: 0, skipped: true, reason: "error" });
    // Must complete well under 1s — the 100ms timeout is the upper bound.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ─── autoPullSkills — install location default ────────────────────────────────

describe("autoPullSkills — install location", () => {
  it("defaults install to 'global' (writes under ~/.claude/skills)", async () => {
    const loadConfigFn = () => makeConfig();
    const { fn: queryFn } = makeMockQuery([sampleRow()]);
    const result = await autoPullSkills({
      loadConfigFn, queryFn,
      // install + cwd intentionally NOT passed — we want the global default.
    });
    expect(result.skipped).toBe(false);
    expect(result.pulled).toBe(1);
    // ~/.claude/skills/<name>--<author>/SKILL.md, with HOME overridden to tmpHome.
    expect(existsSync(join(tmpHome, ".claude/skills/shared-skill--alice/SKILL.md"))).toBe(true);
  });
});

// ─── autoPullSkills — default DeeplakeApi-backed query path ────────────────────

describe("autoPullSkills — no-queryFn path (uses DeeplakeApi)", () => {
  it("falls back to DeeplakeApi.query when deps.queryFn is not injected", async () => {
    // The lambda that wraps `api.query(sql)` is otherwise uncoverable —
    // every other test injects queryFn directly. Module-level vi.mock
    // replaces DeeplakeApi with a stub whose `.query` we observe.
    apiQueryMock.mockResolvedValue([sampleRow()]);
    const loadConfigFn = () => makeConfig();
    const result = await autoPullSkills({
      loadConfigFn,
      // queryFn intentionally omitted — exercise the constructor path
      install: "project",
      cwd: tmpHome,
    });
    expect(result.skipped).toBe(false);
    expect(result.pulled).toBe(1);
    expect(apiQueryMock).toHaveBeenCalledTimes(1);
    expect(apiQueryMock.mock.calls[0][0]).toContain(`FROM "skills"`);
    expect(existsSync(join(tmpHome, ".claude/skills/shared-skill--alice/SKILL.md"))).toBe(true);
  });
});
