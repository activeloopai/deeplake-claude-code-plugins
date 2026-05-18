import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import {
  MEMORY_COLUMNS,
  SESSIONS_COLUMNS,
} from "../../src/deeplake-schema.js";

// Each test gets a fresh marker dir so the per-table CREATE INDEX cache
// in ensureLookupIndex() does not bleed between scenarios.
const ORIG_MARKER_DIR = process.env.HIVEMIND_INDEX_MARKER_DIR;
let markerDir: string;

/**
 * Unit-level mirror of the 7 schema/upgrade scenarios the plugin must
 * survive. Where scenario-matrix.sh measures the runtime outcome
 * against real Deeplake tables, this file pins the SQL the plugin
 * actually sends in each state.
 *
 * New flow (vs the prior one-SELECT-per-column probes): each
 * ensureXxxTable does at most ONE SELECT against `information_schema.columns`
 * and ALTERs only the columns the diff reports missing. CREATE TABLE on
 * a missing table uses the canonical schema, so a fresh table needs no
 * heal pass at all.
 *
 * Mocks only the network boundary (`query`, `listTables`) per CLAUDE.md's
 * testing philosophy.
 */

interface QueryRule {
  match: RegExp;
  // "ok" → returns [] (empty result set; e.g. INSERT/ALTER success, or an
  //         info_schema SELECT that finds nothing).
  // { rows: [...] } → returns those rows (e.g. info_schema SELECT with
  //                   columns_present rows).
  // { errorStatus, errorBody } → throws as if the API responded with that
  //                              error.
  result: "ok" | { rows: Record<string, unknown>[] } | { errorStatus: number; errorBody: string };
}

function makeApi(rules: QueryRule[], existingTables: string[]) {
  const api = new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
  const queryCalls: string[] = [];

  vi.spyOn(api, "listTables").mockResolvedValue(existingTables);
  vi.spyOn(api, "query").mockImplementation(async (sql: string) => {
    queryCalls.push(sql);
    const rule = rules.find(r => r.match.test(sql));
    if (!rule) throw new Error(`unexpected SQL in test: ${sql}`);
    if (rule.result === "ok") return [];
    if ("rows" in rule.result) return rule.result.rows;
    throw new Error(
      `Query failed: ${rule.result.errorStatus}: ${rule.result.errorBody}`,
    );
  });

  return { api, queryCalls };
}

// Patterns the new flow emits. One SELECT info_schema per ensureXxxTable,
// then targeted ALTERs only for columns the diff says are missing.
const SCHEMA_MEM  = /^SELECT column_name FROM information_schema\.columns WHERE table_name = 'memory' AND table_schema = 'ws'$/;
const SCHEMA_SESS = /^SELECT column_name FROM information_schema\.columns WHERE table_name = 'sessions' AND table_schema = 'ws'$/;
const CREATE_MEM  = /^CREATE TABLE IF NOT EXISTS "memory" \(.*summary_embedding FLOAT4\[\]/;
const CREATE_SESS = /^CREATE TABLE IF NOT EXISTS "sessions" \(.*message_embedding FLOAT4\[\]/;
const CREATE_INDEX = /^CREATE INDEX IF NOT EXISTS .* ON "sessions"/;
// Per-column ALTERs: bake the column name into the regex so we can spot
// which legacy columns each scenario heals.
const ALTER_MEM_EMB    = /^ALTER TABLE "memory" ADD COLUMN summary_embedding FLOAT4\[\]$/;
const ALTER_MEM_AGENT  = /^ALTER TABLE "memory" ADD COLUMN agent TEXT NOT NULL DEFAULT ''$/;
const ALTER_MEM_PV     = /^ALTER TABLE "memory" ADD COLUMN plugin_version TEXT NOT NULL DEFAULT ''$/;
const ALTER_SESS_EMB   = /^ALTER TABLE "sessions" ADD COLUMN message_embedding FLOAT4\[\]$/;
const ALTER_SESS_AGENT = /^ALTER TABLE "sessions" ADD COLUMN agent TEXT NOT NULL DEFAULT ''$/;
const ALTER_SESS_PV    = /^ALTER TABLE "sessions" ADD COLUMN plugin_version TEXT NOT NULL DEFAULT ''$/;

const ALREADY_EXISTS = (col: string) => ({
  errorStatus: 500,
  errorBody: `{"error":"Database error: Failed to add column '${col}' to deeplake dataset: Column '${col}' already exists","code":"QUERY_ERROR"}`,
});
const VECTOR_AT = {
  errorStatus: 500,
  errorBody: `{"error":"Database error: Failed to insert tuple: vector::at out of range","code":"QUERY_ERROR"}`,
};

/** Render an info_schema response as `[{ column_name: c }, ...]`. */
const presentRows = (cols: string[]): { rows: Record<string, unknown>[] } => ({
  rows: cols.map(c => ({ column_name: c })),
});

const ALL_MEM_COLS  = MEMORY_COLUMNS.map(c => c.name);
const ALL_SESS_COLS = SESSIONS_COLUMNS.map(c => c.name);
const LEGACY_MEM_COLS  = ALL_MEM_COLS.filter(c => !["summary_embedding", "agent", "plugin_version"].includes(c));
const LEGACY_SESS_COLS = ALL_SESS_COLS.filter(c => !["message_embedding", "agent", "plugin_version"].includes(c));

beforeEach(() => {
  vi.restoreAllMocks();
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  markerDir = mkdtempSync(join(tmpdir(), "hivemind-test-markers-"));
  process.env.HIVEMIND_INDEX_MARKER_DIR = markerDir;
});

afterAll(() => {
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  if (ORIG_MARKER_DIR === undefined) delete process.env.HIVEMIND_INDEX_MARKER_DIR;
  else process.env.HIVEMIND_INDEX_MARKER_DIR = ORIG_MARKER_DIR;
});

// ── Scenarios 1..7 ──────────────────────────────────────────────────────────

describe("scenario 1 — GREENFIELD (memory missing, sessions missing)", () => {
  it("CREATEs both tables embedding-ready; post-CREATE heal SELECT confirms canonical schema, no ALTER", async () => {
    // Post-CREATE heal is mandatory (covers the cached-listTables race
    // where a concurrent writer pre-created a legacy table). On a
    // genuinely fresh CREATE, the SELECT sees the canonical column set
    // and triggers zero ALTERs.
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,    result: "ok" },
        { match: SCHEMA_MEM,    result: presentRows(ALL_MEM_COLS) },
        { match: CREATE_SESS,   result: "ok" },
        { match: SCHEMA_SESS,   result: presentRows(ALL_SESS_COLS) },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      [],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(5);
    expect(queryCalls[0]).toMatch(CREATE_MEM);
    expect(queryCalls[1]).toMatch(SCHEMA_MEM);
    expect(queryCalls[2]).toMatch(CREATE_SESS);
    expect(queryCalls[3]).toMatch(SCHEMA_SESS);
    expect(queryCalls[4]).toMatch(CREATE_INDEX);
    expect(queryCalls.some(s => /^ALTER TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 2 — FULL LEGACY (memory no-emb, sessions no-emb)", () => {
  it("one SELECT per table, then ALTERs the missing summary/message_embedding + agent + plugin_version on each", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(LEGACY_MEM_COLS) },
        { match: ALTER_MEM_EMB,   result: "ok" },
        { match: ALTER_MEM_AGENT, result: "ok" },
        { match: ALTER_MEM_PV,    result: "ok" },
        { match: SCHEMA_SESS,   result: presentRows(LEGACY_SESS_COLS) },
        { match: ALTER_SESS_EMB,   result: "ok" },
        { match: ALTER_SESS_AGENT, result: "ok" },
        { match: ALTER_SESS_PV,    result: "ok" },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    // SELECT_MEM + 3 ALTER_MEM + SELECT_SESS + 3 ALTER_SESS + CREATE_INDEX = 9
    expect(queryCalls).toHaveLength(9);
    expect(queryCalls.some(s => /^CREATE TABLE/.test(s))).toBe(false);
    expect(queryCalls.filter(s => /^ALTER TABLE "memory"/.test(s))).toHaveLength(3);
    expect(queryCalls.filter(s => /^ALTER TABLE "sessions"/.test(s))).toHaveLength(3);
  });
});

describe("scenario 3 — HALF LEGACY MEMORY (memory no-emb, sessions missing)", () => {
  it("SELECT memory → ALTER memory; sessions CREATEd then heal SELECT (canonical schema, no ALTER)", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(LEGACY_MEM_COLS) },
        { match: ALTER_MEM_EMB,   result: "ok" },
        { match: ALTER_MEM_AGENT, result: "ok" },
        { match: ALTER_MEM_PV,    result: "ok" },
        { match: CREATE_SESS,   result: "ok" },
        { match: SCHEMA_SESS,   result: presentRows(ALL_SESS_COLS) },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    // SELECT_MEM + 3 ALTER_MEM + CREATE_SESS + SCHEMA_SESS + CREATE_INDEX = 7
    expect(queryCalls).toHaveLength(7);
    expect(queryCalls.filter(s => /^ALTER TABLE "sessions"/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /^ALTER TABLE "memory"/.test(s))).toHaveLength(3);
  });
});

describe("scenario 4 — HALF LEGACY SESSIONS (memory missing, sessions no-emb)", () => {
  it("memory CREATEd then heal SELECT (no ALTER); sessions SELECT misses → ALTER sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,    result: "ok" },
        { match: SCHEMA_MEM,    result: presentRows(ALL_MEM_COLS) },
        { match: SCHEMA_SESS,   result: presentRows(LEGACY_SESS_COLS) },
        { match: ALTER_SESS_EMB,   result: "ok" },
        { match: ALTER_SESS_AGENT, result: "ok" },
        { match: ALTER_SESS_PV,    result: "ok" },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(7);
    expect(queryCalls.filter(s => /^ALTER TABLE "memory"/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /^ALTER TABLE "sessions"/.test(s))).toHaveLength(3);
  });
});

describe("scenario 5 — FULLY MIGRATED (memory with-emb, sessions with-emb)", () => {
  it("BIG WIN: one SELECT info_schema per table reports every column present → NO ALTER fires anywhere", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(ALL_MEM_COLS) },
        { match: SCHEMA_SESS,   result: presentRows(ALL_SESS_COLS) },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await expect(api.ensureTable()).resolves.toBeUndefined();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();

    // SELECT_MEM + SELECT_SESS + CREATE_INDEX = 3
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls.some(s => /^ALTER TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 6 — MIXED MEM-EMB (memory with-emb, sessions no-emb)", () => {
  it("memory SELECT hits → no ALTER on memory; sessions SELECT misses → ALTER sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(ALL_MEM_COLS) },
        { match: SCHEMA_SESS,   result: presentRows(LEGACY_SESS_COLS) },
        { match: ALTER_SESS_EMB,   result: "ok" },
        { match: ALTER_SESS_AGENT, result: "ok" },
        { match: ALTER_SESS_PV,    result: "ok" },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(6);
    expect(queryCalls.filter(s => /^ALTER TABLE "memory"/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /^ALTER TABLE "sessions"/.test(s))).toHaveLength(3);
  });
});

describe("scenario 7 — MIXED SESS-EMB (memory no-emb, sessions with-emb)", () => {
  it("memory SELECT misses → ALTER memory; sessions SELECT hits → no ALTER on sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(LEGACY_MEM_COLS) },
        { match: ALTER_MEM_EMB,   result: "ok" },
        { match: ALTER_MEM_AGENT, result: "ok" },
        { match: ALTER_MEM_PV,    result: "ok" },
        { match: SCHEMA_SESS,   result: presentRows(ALL_SESS_COLS) },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(6);
    expect(queryCalls.filter(s => /^ALTER TABLE "memory"/.test(s))).toHaveLength(3);
    expect(queryCalls.filter(s => /^ALTER TABLE "sessions"/.test(s))).toHaveLength(0);
  });
});

// ── Cross-cutting invariants ────────────────────────────────────────────────

describe("schema scenarios — cross-cutting invariants", () => {
  it("ALTER 'already exists' (concurrent writer race) is tolerated when re-SELECT confirms the column is present", async () => {
    vi.restoreAllMocks();
    const api = new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
    vi.spyOn(api, "listTables").mockResolvedValue(["memory"]);

    let memSelectCount = 0;
    vi.spyOn(api, "query").mockImplementation(async (sql: string) => {
      if (SCHEMA_MEM.test(sql)) {
        memSelectCount++;
        // First SELECT: legacy schema (embedding missing). Re-SELECT after
        // the racy ALTER: column now present.
        return memSelectCount === 1
          ? LEGACY_MEM_COLS.map(c => ({ column_name: c }))
          : ALL_MEM_COLS.map(c => ({ column_name: c }));
      }
      if (ALTER_MEM_EMB.test(sql)) {
        const err = ALREADY_EXISTS("summary_embedding");
        throw new Error(`Query failed: ${err.errorStatus}: ${err.errorBody}`);
      }
      if (ALTER_MEM_AGENT.test(sql) || ALTER_MEM_PV.test(sql)) return [];
      throw new Error(`unexpected SQL in test: ${sql}`);
    });

    await expect(api.ensureTable()).resolves.toBeUndefined();
    // Initial introspection + re-SELECT after the race.
    expect(memSelectCount).toBe(2);
  });

  it("ALTER errors that are NOT 'already exists' propagate — no silent swallow", async () => {
    const realFailures = [
      { errorStatus: 500, errorBody: '{"error":"random transient backend error"}' },
      { errorStatus: 503, errorBody: "Service Unavailable" },
    ];
    for (const errorResult of realFailures) {
      vi.restoreAllMocks();
      const { api } = makeApi(
        [
          { match: SCHEMA_MEM,  result: presentRows(LEGACY_MEM_COLS) },
          { match: ALTER_MEM_EMB, result: errorResult },
        ],
        ["memory"],
      );
      await expect(api.ensureTable()).rejects.toThrow();
    }
  });

  it("post-ALTER INSERT errors (e.g. vector::at) surface to the caller — capture handles them", async () => {
    const api = new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
    vi.spyOn(api, "query").mockImplementation(async (sql: string) => {
      if (/^INSERT INTO/.test(sql)) {
        throw new Error(`Query failed: 500: ${VECTOR_AT.errorBody}`);
      }
      return [];
    });
    await expect(
      api.query(`INSERT INTO "sessions" (id, message_embedding) VALUES ('x', NULL)`),
    ).rejects.toThrow(/vector::at out of range/);
  });

  it("legacy table missing agent (post-2026-04-11 schema): SELECT misses → ALTER ADD COLUMN agent fires", async () => {
    const memNoAgent  = ALL_MEM_COLS.filter(c => c !== "agent");
    const sessNoAgent = ALL_SESS_COLS.filter(c => c !== "agent");
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,    result: presentRows(memNoAgent) },
        { match: ALTER_MEM_AGENT, result: "ok" },
        { match: SCHEMA_SESS,   result: presentRows(sessNoAgent) },
        { match: ALTER_SESS_AGENT, result: "ok" },
        { match: CREATE_INDEX,  result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toContainEqual(expect.stringMatching(ALTER_MEM_AGENT));
    expect(queryCalls).toContainEqual(expect.stringMatching(ALTER_SESS_AGENT));
    expect(queryCalls.filter(s => /ADD COLUMN summary_embedding/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /ADD COLUMN message_embedding/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /ADD COLUMN agent/.test(s))).toHaveLength(2);
    expect(queryCalls.filter(s => /ADD COLUMN plugin_version/.test(s))).toHaveLength(0);
  });
});
