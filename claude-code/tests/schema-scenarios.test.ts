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
  // "ok"  → returns [] (empty result set; e.g. SELECT info_schema MISS, INSERT/ALTER success)
  // { rows: [...] } → returns those rows (e.g. SELECT info_schema PRESENT)
  // { errorStatus, errorBody } → throws as if the API responded with that error
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

const ALTER_MEM     = /^ALTER TABLE "memory" ADD COLUMN summary_embedding FLOAT4\[\]$/;
const ALTER_SESS    = /^ALTER TABLE "sessions" ADD COLUMN message_embedding FLOAT4\[\]$/;
const ALTER_AGENT_MEM  = /^ALTER TABLE "memory" ADD COLUMN agent TEXT NOT NULL DEFAULT ''$/;
const ALTER_AGENT_SESS = /^ALTER TABLE "sessions" ADD COLUMN agent TEXT NOT NULL DEFAULT ''$/;
const CREATE_MEM    = /^CREATE TABLE IF NOT EXISTS "memory" .*summary_embedding FLOAT4\[\]/;
const CREATE_SESS   = /^CREATE TABLE IF NOT EXISTS "sessions" .*message_embedding FLOAT4\[\]/;
const CREATE_INDEX  = /^CREATE INDEX IF NOT EXISTS .* ON "sessions"/;
// SELECT against information_schema is the new pre-ALTER probe in
// ensureEmbeddingColumn(). Match each table+column combo separately so a
// scenario can declare independent results for memory vs sessions.
const SCHEMA_MEM    = /^SELECT 1 FROM information_schema\.columns WHERE table_name = 'memory' AND column_name = 'summary_embedding' AND table_schema = 'ws'/;
const SCHEMA_SESS   = /^SELECT 1 FROM information_schema\.columns WHERE table_name = 'sessions' AND column_name = 'message_embedding' AND table_schema = 'ws'/;
const SCHEMA_AGENT_MEM  = /^SELECT 1 FROM information_schema\.columns WHERE table_name = 'memory' AND column_name = 'agent' AND table_schema = 'ws'/;
const SCHEMA_AGENT_SESS = /^SELECT 1 FROM information_schema\.columns WHERE table_name = 'sessions' AND column_name = 'agent' AND table_schema = 'ws'/;
// "column present" SELECT result → length > 0 → ensureEmbeddingColumn skips ALTER.
const PRESENT: { rows: Record<string, unknown>[] } = { rows: [{ "?column?": 1 }] };
// "column missing" SELECT result → length 0 → falls through to ALTER. Use plain "ok".
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
  it("CREATEs both tables embedding-ready, post-CREATE info_schema check confirms columns, no ALTER", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,        result: "ok" },
        { match: SCHEMA_MEM,        result: PRESENT },         // CREATE landed embedding-ready
        { match: SCHEMA_AGENT_MEM,  result: PRESENT },         // CREATE included agent column
        { match: CREATE_SESS,       result: "ok" },
        { match: SCHEMA_SESS,       result: PRESENT },
        { match: SCHEMA_AGENT_SESS, result: PRESENT },
        { match: CREATE_INDEX,      result: "ok" },
      ],
      [], // listTables: nothing exists
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    // After CREATE, both ensureColumn calls SELECT info_schema; both columns
    // are present (CREATE included them) → no ALTER fires.
    expect(queryCalls).toHaveLength(7);
    expect(queryCalls[0]).toMatch(CREATE_MEM);
    expect(queryCalls[1]).toMatch(SCHEMA_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[3]).toMatch(CREATE_SESS);
    expect(queryCalls[4]).toMatch(SCHEMA_SESS);
    expect(queryCalls[5]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[6]).toMatch(CREATE_INDEX);
    // No ALTER attempted on a fresh table → no post-ALTER vector::at window.
    expect(queryCalls.some(s => /^ALTER TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 2 — FULL LEGACY (memory no-emb, sessions no-emb)", () => {
  it("SELECTs info_schema for both, finds neither, ALTERs both", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: "ok" },              // embedding column missing
        { match: ALTER_MEM,         result: "ok" },
        { match: SCHEMA_AGENT_MEM,  result: "ok" },              // agent column missing
        { match: ALTER_AGENT_MEM,   result: "ok" },
        { match: SCHEMA_SESS,       result: "ok" },              // embedding column missing
        { match: ALTER_SESS,        result: "ok" },
        { match: SCHEMA_AGENT_SESS, result: "ok" },              // agent column missing
        { match: ALTER_AGENT_SESS,  result: "ok" },
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory", "sessions"], // both legacy tables already present
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(9);
    expect(queryCalls[0]).toMatch(SCHEMA_MEM);
    expect(queryCalls[1]).toMatch(ALTER_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[3]).toMatch(ALTER_AGENT_MEM);
    expect(queryCalls[4]).toMatch(SCHEMA_SESS);
    expect(queryCalls[5]).toMatch(ALTER_SESS);
    expect(queryCalls[6]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[7]).toMatch(ALTER_AGENT_SESS);
    expect(queryCalls[8]).toMatch(CREATE_INDEX);
    expect(queryCalls.some(s => /^CREATE TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 3 — HALF LEGACY MEMORY (memory no-emb, sessions missing)", () => {
  it("SELECT info_schema misses on memory → ALTER memory; sessions CREATEd then info_schema PRESENT confirms", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: "ok" },              // missing → ALTER fires
        { match: ALTER_MEM,         result: "ok" },
        { match: SCHEMA_AGENT_MEM,  result: "ok" },              // legacy memory: also missing agent
        { match: ALTER_AGENT_MEM,   result: "ok" },
        { match: CREATE_SESS,       result: "ok" },
        { match: SCHEMA_SESS,       result: PRESENT },           // CREATE landed embedding-ready
        { match: SCHEMA_AGENT_SESS, result: PRESENT },           // CREATE included agent column
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(8);
    expect(queryCalls[0]).toMatch(SCHEMA_MEM);
    expect(queryCalls[1]).toMatch(ALTER_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[3]).toMatch(ALTER_AGENT_MEM);
    expect(queryCalls[4]).toMatch(CREATE_SESS);
    expect(queryCalls[5]).toMatch(SCHEMA_SESS);
    expect(queryCalls[6]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[7]).toMatch(CREATE_INDEX);
  });
});

describe("scenario 4 — HALF LEGACY SESSIONS (memory missing, sessions no-emb)", () => {
  it("memory CREATEd then info_schema PRESENT; sessions SELECT misses → ALTER sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: CREATE_MEM,        result: "ok" },
        { match: SCHEMA_MEM,        result: PRESENT },
        { match: SCHEMA_AGENT_MEM,  result: PRESENT },           // CREATE included agent column
        { match: SCHEMA_SESS,       result: "ok" },              // missing → ALTER fires
        { match: ALTER_SESS,        result: "ok" },
        { match: SCHEMA_AGENT_SESS, result: "ok" },              // legacy sessions: also missing agent
        { match: ALTER_AGENT_SESS,  result: "ok" },
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(8);
    expect(queryCalls[0]).toMatch(CREATE_MEM);
    expect(queryCalls[1]).toMatch(SCHEMA_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[3]).toMatch(SCHEMA_SESS);
    expect(queryCalls[4]).toMatch(ALTER_SESS);
    expect(queryCalls[5]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[6]).toMatch(ALTER_AGENT_SESS);
    expect(queryCalls[7]).toMatch(CREATE_INDEX);
  });
});

describe("scenario 5 — FULLY MIGRATED (memory with-emb, sessions with-emb)", () => {
  it("BIG WIN: SELECT info_schema returns row for both → NO ALTER fires anywhere", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: PRESENT },           // embedding present
        { match: SCHEMA_AGENT_MEM,  result: PRESENT },           // agent present
        { match: SCHEMA_SESS,       result: PRESENT },           // embedding present
        { match: SCHEMA_AGENT_SESS, result: PRESENT },           // agent present
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await expect(api.ensureTable()).resolves.toBeUndefined();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();

    expect(queryCalls).toHaveLength(5);
    expect(queryCalls[0]).toMatch(SCHEMA_MEM);
    expect(queryCalls[1]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_SESS);
    expect(queryCalls[3]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[4]).toMatch(CREATE_INDEX);
    // Regression guard: pre-fix this scenario sent 2 wasted ALTER 500s on
    // every SessionStart and tickled the post-ALTER vector::at window.
    expect(queryCalls.some(s => /^ALTER TABLE/.test(s))).toBe(false);
  });
});

describe("scenario 6 — MIXED MEM-EMB (memory with-emb, sessions no-emb)", () => {
  it("memory SELECT hits → no ALTER on memory; sessions SELECT misses → ALTER sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: PRESENT },           // embedding present → skip ALTER
        { match: SCHEMA_AGENT_MEM,  result: PRESENT },           // agent present (post-feature memory)
        { match: SCHEMA_SESS,       result: "ok" },              // missing → ALTER fires
        { match: ALTER_SESS,        result: "ok" },
        { match: SCHEMA_AGENT_SESS, result: "ok" },              // legacy sessions: also missing agent
        { match: ALTER_AGENT_SESS,  result: "ok" },
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(7);
    expect(queryCalls[0]).toMatch(SCHEMA_MEM);
    expect(queryCalls[1]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_SESS);
    expect(queryCalls[3]).toMatch(ALTER_SESS);
    expect(queryCalls[4]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[5]).toMatch(ALTER_AGENT_SESS);
    expect(queryCalls[6]).toMatch(CREATE_INDEX);
    expect(queryCalls.filter(s => /^ALTER TABLE/.test(s))).toHaveLength(2); // sessions: embedding + agent
  });
});

describe("scenario 7 — MIXED SESS-EMB (memory no-emb, sessions with-emb)", () => {
  it("memory SELECT misses → ALTER memory; sessions SELECT hits → no ALTER on sessions", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: "ok" },              // missing → ALTER fires
        { match: ALTER_MEM,         result: "ok" },
        { match: SCHEMA_AGENT_MEM,  result: "ok" },              // legacy memory: also missing agent
        { match: ALTER_AGENT_MEM,   result: "ok" },
        { match: SCHEMA_SESS,       result: PRESENT },           // embedding present → skip ALTER
        { match: SCHEMA_AGENT_SESS, result: PRESENT },           // agent present (post-feature sessions)
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(7);
    expect(queryCalls[0]).toMatch(SCHEMA_MEM);
    expect(queryCalls[1]).toMatch(ALTER_MEM);
    expect(queryCalls[2]).toMatch(SCHEMA_AGENT_MEM);
    expect(queryCalls[3]).toMatch(ALTER_AGENT_MEM);
    expect(queryCalls[4]).toMatch(SCHEMA_SESS);
    expect(queryCalls[5]).toMatch(SCHEMA_AGENT_SESS);
    expect(queryCalls[6]).toMatch(CREATE_INDEX);
    expect(queryCalls.filter(s => /^ALTER TABLE/.test(s))).toHaveLength(2); // memory: embedding + agent
  });
});

// ── Cross-cutting invariants ────────────────────────────────────────────────

describe("schema scenarios — cross-cutting invariants", () => {
  it("ALTER 'column already exists' (concurrent writer race) is the ONLY tolerated error — re-SELECT confirms and ensureTable resolves", async () => {
    // Single tolerated race: another writer added the column between our
    // SELECT (missing) and our ALTER (already-exists). Re-SELECT confirms
    // the column exists now → success. All other ALTER failures propagate.
    vi.restoreAllMocks();
    const api = new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
    vi.spyOn(api, "listTables").mockResolvedValue(["memory", "sessions"]);

    let memSchemaSelectCount = 0;
    vi.spyOn(api, "query").mockImplementation(async (sql: string) => {
      if (SCHEMA_MEM.test(sql)) {
        // First SELECT misses; re-SELECT after the racy ALTER finds it present.
        return memSchemaSelectCount++ === 0 ? [] : PRESENT.rows;
      }
      if (ALTER_MEM.test(sql)) {
        throw new Error(`Query failed: ${ALREADY_EXISTS("summary_embedding").errorStatus}: ${ALREADY_EXISTS("summary_embedding").errorBody}`);
      }
      if (SCHEMA_AGENT_MEM.test(sql)) return PRESENT.rows;
      if (SCHEMA_SESS.test(sql)) return PRESENT.rows;
      if (SCHEMA_AGENT_SESS.test(sql)) return PRESENT.rows;
      if (CREATE_INDEX.test(sql)) return [];
      throw new Error(`unexpected SQL in test: ${sql}`);
    });

    await expect(api.ensureTable()).resolves.toBeUndefined();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();
    expect(memSchemaSelectCount).toBe(2); // initial miss + re-confirm
  });

  it("ALTER errors that are NOT 'already exists' propagate — ensureTable rejects (no silent swallow)", async () => {
    // No fallback: if the SELECT reports missing and the ALTER hits a real
    // failure (not the race), the caller sees the error. Replaces the old
    // catch-everything behaviour so genuine schema problems aren't masked.
    const realFailures = [
      { errorStatus: 500, errorBody: '{"error":"random transient backend error"}' },
      { errorStatus: 503, errorBody: "Service Unavailable" },
    ];
    for (const errorResult of realFailures) {
      vi.restoreAllMocks();
      const { api } = makeApi(
        [
          { match: SCHEMA_MEM,   result: "ok" },              // missing
          { match: ALTER_MEM,    result: errorResult },       // ALTER blows up
          { match: SCHEMA_SESS,  result: "ok" },
          { match: ALTER_SESS,   result: errorResult },
          { match: CREATE_INDEX, result: "ok" },
        ],
        ["memory", "sessions"],
      );
      await expect(api.ensureTable()).rejects.toThrow();
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

  // Regression guard for the gap in the prior fallback: pre-2026-04-11
  // tables have neither summary_embedding/message_embedding nor agent.
  // Embedding ALTER was already covered, but agent had no fallback at all
  // — every INSERT after upgrade failed with `column "agent" does not
  // exist`. ensureColumn now patches up agent the same way.
  it("legacy table missing agent (post-2026-04-11 schema): SELECT misses → ALTER ADD COLUMN agent fires", async () => {
    const { api, queryCalls } = makeApi(
      [
        { match: SCHEMA_MEM,        result: PRESENT },              // embedding column already there
        { match: SCHEMA_AGENT_MEM,  result: "ok" },                 // agent missing
        { match: ALTER_AGENT_MEM,   result: "ok" },                 // ALTER fires
        { match: SCHEMA_SESS,       result: PRESENT },
        { match: SCHEMA_AGENT_SESS, result: "ok" },                 // agent missing
        { match: ALTER_AGENT_SESS,  result: "ok" },                 // ALTER fires
        { match: CREATE_INDEX,      result: "ok" },
      ],
      ["memory", "sessions"],
    );

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(queryCalls).toHaveLength(7);
    expect(queryCalls).toContainEqual(expect.stringMatching(ALTER_AGENT_MEM));
    expect(queryCalls).toContainEqual(expect.stringMatching(ALTER_AGENT_SESS));
    // Only the agent-column ALTERs should fire; embedding ALTER must NOT.
    expect(queryCalls.filter(s => /^ALTER TABLE.*summary_embedding/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /^ALTER TABLE.*message_embedding/.test(s))).toHaveLength(0);
    expect(queryCalls.filter(s => /^ALTER TABLE.*ADD COLUMN agent/.test(s))).toHaveLength(2);
  });
});
