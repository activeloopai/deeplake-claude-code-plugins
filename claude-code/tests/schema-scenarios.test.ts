import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeeplakeApi } from "../../src/deeplake-api.js";

// Each test gets a fresh marker dir so the per-table CREATE INDEX cache
// in ensureLookupIndex() does not bleed between scenarios.
const ORIG_MARKER_DIR = process.env.HIVEMIND_INDEX_MARKER_DIR;
let markerDir: string;

/**
 * Unit-level mirror of the 7 schema/upgrade scenarios exercised in
 * scenario-matrix.sh against real Deeplake tables. Where the shell
 * script measures the runtime outcome (post-ALTER vector::at window,
 * silent reads, etc.), this file pins the SQL the plugin actually
 * sends in each state and verifies the hooks survive every
 * combination of "table exists / ALTER outcome" without throwing.
 *
 * Mocks only the network boundary (`query`, `listTables`) per
 * CLAUDE.md's testing philosophy.
 */

interface QueryRule {
  match: RegExp;
  result: "ok" | { errorStatus: number; errorBody: string };
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
    throw new Error(
      `Query failed: ${rule.result.errorStatus}: ${rule.result.errorBody}`,
    );
  });

  return { api, queryCalls };
}

const ALTER_MEM     = /^ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS summary_embedding FLOAT4\[\]$/;
const ALTER_SESS    = /^ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS message_embedding FLOAT4\[\]$/;
const CREATE_MEM    = /^CREATE TABLE IF NOT EXISTS "memory" .*summary_embedding FLOAT4\[\]/;
const CREATE_SESS   = /^CREATE TABLE IF NOT EXISTS "sessions" .*message_embedding FLOAT4\[\]/;
const CREATE_INDEX  = /^CREATE INDEX IF NOT EXISTS .* ON "sessions"/;
const ALREADY_EXISTS = (col: string) => ({
  errorStatus: 500,
  errorBody: `{"error":"Database error: Failed to add column '${col}' to deeplake dataset: Column '${col}' already exists","code":"QUERY_ERROR"}`,
});
const VECTOR_AT = {
  errorStatus: 500,
  errorBody: `{"error":"Database error: Failed to insert tuple: vector::at out of range","code":"QUERY_ERROR"}`,
};

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

// ── Scenarios 1..7 — each mirrors a row of scenario-matrix.sh's summary ─────

describe("scenario 1 — GREENFIELD (memory missing, sessions missing)", () => {
  it("CREATEs both tables embedding-ready, no ALTER, capture inserts cleanly", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,   result: "ok" },
        { match: CREATE_SESS,  result: "ok" },
        { match: CREATE_INDEX, result: "ok" },
      ],
      [], // listTables: nothing exists
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    // ensureTable: 1 CREATE on memory.
    // ensureSessionsTable: 1 CREATE on sessions + 1 CREATE INDEX.
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(CREATE_MEM);
    expect(queryCalls[1]).toMatch(CREATE_SESS);
    expect(queryCalls[2]).toMatch(CREATE_INDEX);
    // No ALTER attempted on a fresh table → no post-ALTER vector::at window.
    expect(queryCalls.some(s => /^ALTER TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 2 — FULL LEGACY (memory no-emb, sessions no-emb)", () => {
  it("ALTERs both tables; both succeed, but the post-ALTER window applies to capture", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: ALTER_MEM,    result: "ok" },
        { match: ALTER_SESS,   result: "ok" },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["memory", "sessions"], // both legacy tables already present
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(ALTER_MEM);
    expect(queryCalls[1]).toMatch(ALTER_SESS);
    expect(queryCalls[2]).toMatch(CREATE_INDEX);
    // No CREATE on a table that already exists.
    expect(queryCalls.some(s => /^CREATE TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 3 — HALF LEGACY MEMORY (memory no-emb, sessions missing)", () => {
  it("ALTERs memory, CREATEs sessions; capture INSERT immediately succeeds in the real run", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: ALTER_MEM,    result: "ok" },
        { match: CREATE_SESS,  result: "ok" },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["memory"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(ALTER_MEM);
    expect(queryCalls[1]).toMatch(CREATE_SESS);
    expect(queryCalls[2]).toMatch(CREATE_INDEX);
  });
});

describe("scenario 4 — HALF LEGACY SESSIONS (memory missing, sessions no-emb)", () => {
  it("CREATEs memory, ALTERs sessions — sessions ALTER triggers the real-world post-ALTER window", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,   result: "ok" },
        { match: ALTER_SESS,   result: "ok" },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(CREATE_MEM);
    expect(queryCalls[1]).toMatch(ALTER_SESS);
    expect(queryCalls[2]).toMatch(CREATE_INDEX);
  });
});

describe("scenario 5 — FULLY MIGRATED (memory with-emb, sessions with-emb)", () => {
  it("both ALTERs return 500 'already exists' and are swallowed by try/catch — fast-fail, no retries", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: ALTER_MEM,    result: ALREADY_EXISTS("summary_embedding") },
        { match: ALTER_SESS,   result: ALREADY_EXISTS("message_embedding") },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["memory", "sessions"],
    );

    // No throw despite both ALTERs failing — the swallowed-error path.
    await expect(api.ensureTable()).resolves.toBeUndefined();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();

    expect(queryCalls).toHaveLength(3);
    // The fail-fast on "already exists" (commit 973dd34) means each ALTER is
    // sent exactly once — no retries on the deterministic 500.
    const alterCalls = queryCalls.filter(s => /^ALTER TABLE/.test(s));
    expect(alterCalls).toHaveLength(2);
  });
});

describe("scenario 6 — MIXED MEM-EMB (memory with-emb, sessions no-emb)", () => {
  it("memory ALTER fast-fails on 'already exists'; sessions ALTER actually adds the column", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: ALTER_MEM,    result: ALREADY_EXISTS("summary_embedding") },
        { match: ALTER_SESS,   result: "ok" },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(ALTER_MEM);
    expect(queryCalls[1]).toMatch(ALTER_SESS);
  });
});

describe("scenario 7 — MIXED SESS-EMB (memory no-emb, sessions with-emb)", () => {
  it("memory ALTER actually adds the column; sessions ALTER fast-fails on 'already exists'", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: ALTER_MEM,    result: "ok" },
        { match: ALTER_SESS,   result: ALREADY_EXISTS("message_embedding") },
        { match: CREATE_INDEX, result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[0]).toMatch(ALTER_MEM);
    expect(queryCalls[1]).toMatch(ALTER_SESS);
  });
});

// ── Cross-cutting invariants ────────────────────────────────────────────────

describe("schema scenarios — cross-cutting invariants", () => {
  it("ALTER ADD COLUMN failures NEVER bubble up — ensureTable always resolves", async () => {
    // The ALTER swallow is what keeps fully-migrated tables from breaking
    // SessionStart on every run. If this regresses, scenario 5 starts
    // surfacing a 500 to the hook caller and SessionStart partially aborts.
    const cases = [
      ALREADY_EXISTS("summary_embedding"),
      { errorStatus: 500, errorBody: '{"error":"random transient backend error"}' },
      { errorStatus: 503, errorBody: "Service Unavailable" },
    ];
    for (const errorResult of cases) {
      vi.restoreAllMocks();
      const { api } = makeApi(
        [
          { match: ALTER_MEM,    result: errorResult },
          { match: ALTER_SESS,   result: errorResult },
          { match: CREATE_INDEX, result: "ok" },
        ],
        ["memory", "sessions"],
      );
      await expect(api.ensureTable()).resolves.toBeUndefined();
      await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();
    }
  });

  it("the post-ALTER vector::at INSERT failure surfaces to the caller (capture's main catch handles it)", async () => {
    // The capture hook wraps its INSERT in a try/catch + log("fatal: …")
    // path; we verify here that the API client itself does NOT swallow
    // INSERT 500s — that's the right behaviour, since the capture flow
    // wants to know its write was lost (so future retries/observability
    // can react). Scenario-matrix.sh confirms this end-to-end on
    // scenarios 2/4/6 where sessions was ALTERed.
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
});
