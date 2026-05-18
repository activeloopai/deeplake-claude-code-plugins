import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeeplakeApi, WriteRow } from "../../src/deeplake-api.js";

// ��─ Mock fetch ──────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeApi(table = "test_table") {
  return new DeeplakeApi("tok", "https://api.test", "org1", "ws1", table);
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.HIVEMIND_INDEX_MARKER_DIR = mkdtempSync(join(tmpdir(), "hivemind-index-marker-"));
});

afterEach(() => {
  delete process.env.HIVEMIND_INDEX_MARKER_DIR;
});

// ── query() ─────────────────────────────────────────────────────────────────

describe("DeeplakeApi.query", () => {
  it("sends correct SQL and parses rows", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      columns: ["id", "name"],
      rows: [["1", "alice"], ["2", "bob"]],
    }));
    const api = makeApi();
    const rows = await api.query("SELECT id, name FROM t");

    expect(rows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/workspaces/ws1/tables/query");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer tok");
    expect(opts.headers["X-Activeloop-Org-Id"]).toBe("org1");
    expect(JSON.parse(opts.body)).toEqual({ query: "SELECT id, name FROM t" });
  });

  it("returns empty array when response has no rows", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    const rows = await api.query("SELECT 1");
    expect(rows).toEqual([]);
  });

  it("returns empty array when response is null", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null));
    const api = makeApi();
    const rows = await api.query("SELECT 1");
    expect(rows).toEqual([]);
  });

  it("retries on 429 and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse("rate limited", 429))
      .mockResolvedValueOnce(jsonResponse({ columns: ["x"], rows: [["ok"]] }));
    const api = makeApi();
    const rows = await api.query("SELECT x FROM t");
    expect(rows).toEqual([{ x: "ok" }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse("error", 500))
      .mockResolvedValueOnce(jsonResponse({ columns: ["x"], rows: [["ok"]] }));
    const api = makeApi();
    const rows = await api.query("SELECT x FROM t");
    expect(rows).toEqual([{ x: "ok" }]);
  });

  it("retries transient HTML 403s for session inserts", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => "<html><head><title>403 Forbidden</title></head><body>nginx</body></html>",
      })
      .mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    const rows = await api.query(
      'INSERT INTO "sessions" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) VALUES (\'id\', \'/p\', \'f\', \'{}\'::jsonb, \'u\', 2, \'p\', \'Stop\', \'claude_code\', \'t\', \'t\')',
    );
    expect(rows).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 502/503/504", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse("", 502))
      .mockResolvedValueOnce(jsonResponse("", 503))
      .mockResolvedValueOnce(jsonResponse("", 504))
      .mockResolvedValueOnce(jsonResponse({ columns: ["x"], rows: [["ok"]] }));
    const api = makeApi();
    const rows = await api.query("SELECT x FROM t");
    expect(rows).toEqual([{ x: "ok" }]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("throws after max retries on retryable errors", async () => {
    mockFetch.mockResolvedValue(jsonResponse("error", 500));
    const api = makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow("Query failed: 500");
  });

  it("throws immediately on non-retryable error (400)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse("bad request", 400));
    const api = makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow("Query failed: 400");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("retries on network/fetch errors", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ columns: ["x"], rows: [["ok"]] }));
    const api = makeApi();
    const rows = await api.query("SELECT x FROM t");
    expect(rows).toEqual([{ x: "ok" }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries on network errors", async () => {
    mockFetch.mockRejectedValue(new Error("DNS_FAIL"));
    const api = makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow("DNS_FAIL");
  });

  it("fails fast on timeout-like fetch errors without retrying", async () => {
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(timeoutError);
    const api = makeApi();

    await expect(api.query("SELECT 1")).rejects.toThrow("Query timeout after 10000ms");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal to query fetches", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ columns: ["x"], rows: [["ok"]] }));
    const api = makeApi();
    await api.query("SELECT 1");

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps non-Error fetch exceptions", async () => {
    mockFetch.mockRejectedValue("string error");
    const api = makeApi();
    await expect(api.query("SELECT 1")).rejects.toThrow("string error");
  });
});

// ── Semaphore / concurrency ─────────────────────────────────────────────────

describe("DeeplakeApi concurrency", () => {
  it("limits concurrent queries", async () => {
    let active = 0;
    let maxActive = 0;
    mockFetch.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return jsonResponse({ columns: ["x"], rows: [["ok"]] });
    });
    const api = makeApi();
    await Promise.all(Array.from({ length: 10 }, () => api.query("SELECT 1")));
    expect(maxActive).toBeLessThanOrEqual(5);
  });
});

// ── appendRows / commit ─────────────────────────────────────────────────────

describe("DeeplakeApi.commit", () => {
  it("does nothing when no rows are pending", async () => {
    const api = makeApi();
    await api.commit();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upserts pending rows (insert path)", async () => {
    // First call: SELECT to check exists → empty (not found)
    // Second call: INSERT
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ columns: ["path"], rows: [] }))  // exists check
      .mockResolvedValueOnce(jsonResponse({}));  // insert
    const api = makeApi();
    api.appendRows([{
      path: "/test.md",
      filename: "test.md",
      contentText: "hello",
      mimeType: "text/markdown",
      sizeBytes: 5,
    }]);
    await api.commit();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const insertCall = mockFetch.mock.calls[1];
    const sql = JSON.parse(insertCall[1].body).query;
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("/test.md");
  });

  it("upserts pending rows (update path)", async () => {
    // First call: SELECT to check exists → found
    // Second call: UPDATE
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ columns: ["path"], rows: [["/test.md"]] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    api.appendRows([{
      path: "/test.md",
      filename: "test.md",
      contentText: "updated",
      mimeType: "text/markdown",
      sizeBytes: 7,
    }]);
    await api.commit();
    const updateCall = mockFetch.mock.calls[1];
    const sql = JSON.parse(updateCall[1].body).query;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("updated");
  });

  it("includes project and description in insert when provided", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ columns: ["path"], rows: [] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    api.appendRows([{
      path: "/test.md",
      filename: "test.md",
      contentText: "hello",
      mimeType: "text/markdown",
      sizeBytes: 5,
      project: "myproject",
      description: "a description",
    }]);
    await api.commit();
    const sql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(sql).toContain("project");
    expect(sql).toContain("myproject");
    expect(sql).toContain("description");
    expect(sql).toContain("a description");
  });

  it("includes project and description in update when provided", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ columns: ["path"], rows: [["/test.md"]] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    api.appendRows([{
      path: "/test.md",
      filename: "test.md",
      contentText: "hello",
      mimeType: "text/markdown",
      sizeBytes: 5,
      project: "myproject",
      description: "a description",
    }]);
    await api.commit();
    const sql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(sql).toContain("project");
    expect(sql).toContain("description");
  });
});

// ── updateColumns ─��─────────────────────────────────────────────────────────

describe("DeeplakeApi.updateColumns", () => {
  it("generates correct UPDATE SQL with string and number columns", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    await api.updateColumns("/test.md", { description: "new desc", size_bytes: 42 });
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("description = 'new desc'");
    expect(sql).toContain("size_bytes = 42");
    expect(sql).toContain("WHERE path = '/test.md'");
  });
});

// ── createIndex ─────────────────────────────────────────────────────────────

describe("DeeplakeApi.createIndex", () => {
  it("generates correct CREATE INDEX SQL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    await api.createIndex("summary");
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(sql).toContain("deeplake_index");
    expect(sql).toContain("summary");
  });
});

// ── listTables ──────────────────────────────────────────────────────────────

describe("DeeplakeApi.listTables", () => {
  it("returns table names", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tables: [{ table_name: "memory" }, { table_name: "sessions" }] }),
    });
    const api = makeApi();
    const tables = await api.listTables();
    expect(tables).toEqual(["memory", "sessions"]);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/workspaces/ws1/tables");
  });

  it("returns empty array when response has no tables", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({}),
    });
    const api = makeApi();
    expect(await api.listTables()).toEqual([]);
  });

  it("retries on 500 and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "" })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ tables: [{ table_name: "t1" }] }),
      });
    const api = makeApi();
    expect(await api.listTables()).toEqual(["t1"]);
  });

  it("returns empty array on non-retryable HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "" });
    const api = makeApi();
    expect(await api.listTables()).toEqual([]);
  });

  it("retries on network error and succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ tables: [{ table_name: "t1" }] }),
      });
    const api = makeApi();
    expect(await api.listTables()).toEqual(["t1"]);
  });

  it("returns empty array after max network retries", async () => {
    mockFetch.mockRejectedValue(new Error("FAIL"));
    const api = makeApi();
    expect(await api.listTables()).toEqual([]);
  });

  it("caches successful results per api instance", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tables: [{ table_name: "memory" }, { table_name: "sessions" }] }),
    });
    const api = makeApi();

    expect(await api.listTables()).toEqual(["memory", "sessions"]);
    expect(await api.listTables()).toEqual(["memory", "sessions"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── ensureXxxTable helpers (new schema-heal flow) ───────────────────────────

import {
  MEMORY_COLUMNS,
  SESSIONS_COLUMNS,
  SKILLS_COLUMNS,
} from "../../src/deeplake-schema.js";

/** Render an info_schema response shape: `[{ column_name: "<name>" }, ...]`. */
function infoSchemaResponse(present: string[]) {
  return jsonResponse({
    columns: ["column_name"],
    rows: present.map(c => [c]),
  });
}

/** Convenience: every column of a schema is present. */
const allOf = (cols: readonly { name: string }[]) => cols.map(c => c.name);

// ── ensureTable ─────────────────────────────────────────────────────────────

describe("DeeplakeApi.ensureTable", () => {
  it("creates table when it does not exist, then runs an unconditional heal pass (covers stale-listTables race)", async () => {
    // listTables: empty → CREATE TABLE → heal pass (SELECT info_schema)
    // The post-CREATE heal pass is mandatory even on a fresh table:
    // `listTables()` is cached, so a concurrent writer may have created
    // an older table just before our CREATE no-op'd. SELECT sees the
    // canonical schema we created → 0 ALTERs.
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE TABLE
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(MEMORY_COLUMNS)));    // heal SELECT
    const api = makeApi("my_table");
    await api.ensureTable();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS "my_table"`);
    expect(createSql).toContain("USING deeplake");
    expect(createSql).toContain("summary_embedding FLOAT4[]");
    expect(createSql).toContain("plugin_version TEXT NOT NULL DEFAULT ''");
    const allSql = mockFetch.mock.calls.filter(c => c[1]?.body).map(c => JSON.parse(c[1].body).query).join(" | ");
    expect(allSql).not.toContain("ALTER TABLE");
  });

  it("on existing table: ONE SELECT info_schema, then ALTER only the genuinely missing columns", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    // Table missing summary_embedding only. SELECT returns every other column.
    const presentCols = allOf(MEMORY_COLUMNS).filter(c => c !== "summary_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentCols));
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // ALTER summary_embedding
    const api = makeApi("my_table");
    await api.ensureTable();
    expect(mockFetch).toHaveBeenCalledTimes(3); // listTables + SELECT + 1 ALTER

    const selectSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(selectSql).toMatch(/^SELECT column_name FROM information_schema\.columns/);
    expect(selectSql).toContain(`table_name = 'my_table'`);
    expect(selectSql).toContain(`table_schema = 'ws1'`);

    const alterSql = JSON.parse(mockFetch.mock.calls[2][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "my_table" ADD COLUMN summary_embedding FLOAT4[]`);
    expect(alterSql).not.toContain("IF NOT EXISTS"); // strict: SELECT confirmed missing
  });

  it("on existing table where SELECT info_schema reports every column present: NO ALTER fires", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(MEMORY_COLUMNS)));
    const api = makeApi("my_table");
    await api.ensureTable();
    // listTables + SELECT — no ALTER, no extra round-trips.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const allSql = mockFetch.mock.calls.filter(c => c[1]?.body).map(c => JSON.parse(c[1].body).query).join(" | ");
    expect(allSql).not.toContain("ALTER TABLE");
  });

  it("propagates information_schema query errors (no silent fall-through to ALTER)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse("syntax error", 400));
    const api = makeApi("my_table");
    await expect(api.ensureTable()).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates non-race ALTER errors instead of swallowing them", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    const presentCols = allOf(MEMORY_COLUMNS).filter(c => c !== "summary_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentCols));
    mockFetch.mockResolvedValueOnce(jsonResponse("syntax error", 400));
    const api = makeApi("my_table");
    await expect(api.ensureTable()).rejects.toThrow();
  });

  it("tolerates 'Column already exists' on ALTER when re-SELECT confirms the race winner landed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    const presentBefore = allOf(MEMORY_COLUMNS).filter(c => c !== "summary_embedding");
    const presentAfter = allOf(MEMORY_COLUMNS); // race winner added it
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentBefore));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(`{"error":"Database error: Failed to add column 'summary_embedding' to deeplake dataset: Column 'summary_embedding' already exists","code":"QUERY_ERROR"}`, 500),
    );
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentAfter)); // re-SELECT confirms

    const api = makeApi("my_table");
    await expect(api.ensureTable()).resolves.toBeUndefined();
    // listTables + SELECT(miss) + ALTER(race) + re-SELECT(confirm)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("rejects 'Column already exists' on ALTER when re-SELECT still reports the column missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    const presentBefore = allOf(MEMORY_COLUMNS).filter(c => c !== "summary_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentBefore));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(`{"error":"Database error: Column 'summary_embedding' already exists","code":"QUERY_ERROR"}`, 500),
    );
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(presentBefore)); // still missing
    const api = makeApi("my_table");
    await expect(api.ensureTable()).rejects.toThrow();
  });

  it("creates table with custom name", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE TABLE
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(MEMORY_COLUMNS)));    // post-CREATE heal SELECT
    const api = makeApi("default_table");
    await api.ensureTable("custom_table");
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS "custom_table"`);
  });

  it("heals after CREATE: race-detected legacy table gets ALTERed before returning", async () => {
    // Regression for the CodeRabbit-flagged race: listTables() reports
    // the table missing (cache stale), we run CREATE TABLE IF NOT EXISTS
    // (no-op against a concurrent writer's older table), and the
    // unconditional heal pass discovers + repairs the legacy schema.
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                                // CREATE (no-op)
    // Heal SELECT returns the *legacy* shape (missing summary_embedding)
    const legacy = allOf(MEMORY_COLUMNS).filter(c => c !== "summary_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(legacy));
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                                // ALTER
    const api = makeApi("my_table");
    await api.ensureTable();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const alterSql = JSON.parse(mockFetch.mock.calls[3][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "my_table" ADD COLUMN summary_embedding FLOAT4[]`);
  });

  it("reuses cached listTables across ensureTable and ensureSessionsTable; each gets its own SELECT info_schema", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "memory" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(MEMORY_COLUMNS)));    // memory: all present
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE sessions
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));   // post-CREATE heal SELECT for sessions
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE INDEX
    const api = makeApi("memory");

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    // listTables (cached for the 2nd call) + memory SELECT + sessions CREATE
    // + sessions heal SELECT + INDEX
    expect(mockFetch).toHaveBeenCalledTimes(5);
    const sessionsCreate = JSON.parse(mockFetch.mock.calls[2][1].body).query;
    expect(sessionsCreate).toContain(`CREATE TABLE IF NOT EXISTS "sessions"`);
    const indexSql = JSON.parse(mockFetch.mock.calls[4][1].body).query;
    expect(indexSql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(indexSql).toContain(`"path"`);
    expect(indexSql).toContain(`"creation_date"`);
  });
});

// ── ensureSessionsTable ─────────────────────────────────────────────────────

describe("DeeplakeApi.ensureSessionsTable", () => {
  it("creates sessions table when it does not exist; heals unconditionally after CREATE", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE TABLE
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));    // post-CREATE heal SELECT
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE INDEX
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledTimes(4); // listTables + CREATE + heal SELECT + CREATE INDEX

    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS "sessions"`);
    expect(createSql).toContain("JSONB");
    expect(createSql).toContain("USING deeplake");
    expect(createSql).toContain("message_embedding FLOAT4[]");
    expect(createSql).toContain("plugin_version TEXT NOT NULL DEFAULT ''");

    const indexSql = JSON.parse(mockFetch.mock.calls[3][1].body).query;
    expect(indexSql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(indexSql).toContain(`"sessions"`);
    expect(indexSql).toContain(`("path", "creation_date")`);
  });

  it("heals after CREATE: race-detected legacy sessions table gets ALTERed before returning", async () => {
    // Same race shape as ensureTable: listTables() reports the table
    // missing (cache stale), CREATE TABLE IF NOT EXISTS no-ops against a
    // concurrent writer's legacy table, and the unconditional heal pass
    // discovers + repairs the older schema before ensureLookupIndex runs.
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE (no-op vs legacy)
    const legacy = allOf(SESSIONS_COLUMNS).filter(c => c !== "message_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(legacy));                    // heal SELECT
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // ALTER
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                              // CREATE INDEX
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledTimes(5);
    const alterSql = JSON.parse(mockFetch.mock.calls[3][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "sessions" ADD COLUMN message_embedding FLOAT4[]`);
  });

  it("on existing sessions table: ONE SELECT info_schema, then targeted ALTER for any missing columns", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "sessions" }] }),
    });
    // Pre-existing table missing message_embedding only.
    const present = allOf(SESSIONS_COLUMNS).filter(c => c !== "message_embedding");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(present));
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // ALTER message_embedding
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // CREATE INDEX
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledTimes(4); // listTables + SELECT + 1 ALTER + INDEX

    const alterSql = JSON.parse(mockFetch.mock.calls[2][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "sessions" ADD COLUMN message_embedding FLOAT4[]`);
    expect(alterSql).not.toContain("IF NOT EXISTS");
  });

  it("skips ALTER on sessions when info_schema reports every column already present", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "sessions" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // CREATE INDEX (always runs, marker-gated)
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledTimes(3); // listTables + SELECT + INDEX

    const allSql = mockFetch.mock.calls.filter(c => c[1]?.body).map(c => JSON.parse(c[1].body).query).join(" | ");
    expect(allSql).not.toContain("ALTER TABLE");
  });

  it("ignores lookup-index creation errors after ensuring the sessions table", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "sessions" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));
    mockFetch.mockResolvedValueOnce(jsonResponse("forbidden", 403));
    const api = makeApi();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("treats duplicate concurrent index creation errors as success and records a local marker", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "sessions" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));
    mockFetch.mockResolvedValueOnce(jsonResponse("duplicate key value violates unique constraint \"pg_class_relname_nsp_index\"", 400));
    const api = makeApi();
    await expect(api.ensureSessionsTable("sessions")).resolves.toBeUndefined();

    // 2nd call: listTables cached, SELECT info_schema still runs (no column
    // marker any more — we trade those few SELECTs for clearer logic and
    // remove a stale on-disk cache that could mislead diagnostics).
    // CREATE INDEX is gated by the lookup-index marker, which was set on
    // the first call's "duplicate" race-tolerance branch → 0 INDEX fetch.
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)));
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── ensureSkillsTable ───────────────────────────────────────────────────────

describe("DeeplakeApi.ensureSkillsTable", () => {
  it("creates skills table when it does not exist; heals unconditionally after CREATE", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE TABLE
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SKILLS_COLUMNS)));    // post-CREATE heal SELECT
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE INDEX
    const api = makeApi();
    await api.ensureSkillsTable("skills");
    expect(mockFetch).toHaveBeenCalledTimes(4);

    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS "skills"`);
    expect(createSql).toContain("contributors TEXT NOT NULL DEFAULT '[]'");
    expect(createSql).toContain("version BIGINT NOT NULL DEFAULT 1");
  });

  it("heals after CREATE: race-detected legacy skills table gets ALTERed before returning", async () => {
    // Same race shape as ensureTable / ensureSessionsTable: stale
    // listTables() + concurrent CREATE from another writer turns this
    // CREATE TABLE IF NOT EXISTS into a no-op against an older schema.
    // The unconditional heal pass adds the missing column before
    // ensureLookupIndex fires.
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE (no-op vs legacy)
    const legacy = allOf(SKILLS_COLUMNS).filter(c => c !== "contributors");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(legacy));                  // heal SELECT
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // ALTER
    mockFetch.mockResolvedValueOnce(jsonResponse({}));                            // CREATE INDEX
    const api = makeApi();
    await api.ensureSkillsTable("skills");
    expect(mockFetch).toHaveBeenCalledTimes(5);
    const alterSql = JSON.parse(mockFetch.mock.calls[3][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`);
  });

  it("on existing skills table: SELECT info_schema + ALTER missing columns", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "skills" }] }),
    });
    const present = allOf(SKILLS_COLUMNS).filter(c => c !== "contributors");
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(present));
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // ALTER contributors
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // CREATE INDEX
    const api = makeApi();
    await api.ensureSkillsTable("skills");
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const alterSql = JSON.parse(mockFetch.mock.calls[2][1].body).query;
    expect(alterSql).toBe(`ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`);
  });

  it("on existing skills table fully up-to-date: no ALTER fires", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "skills" }] }),
    });
    mockFetch.mockResolvedValueOnce(infoSchemaResponse(allOf(SKILLS_COLUMNS)));
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // CREATE INDEX (marker-gated)
    const api = makeApi();
    await api.ensureSkillsTable("skills");
    const allSql = mockFetch.mock.calls.filter(c => c[1]?.body).map(c => JSON.parse(c[1].body).query).join(" | ");
    expect(allSql).not.toContain("ALTER TABLE");
  });
});

// ── traceSql coverage ─────────────────────────────────────────────────────
describe("traceSql (indirect, via query() with trace env set)", () => {
  const stderrSpy = vi.spyOn(process.stderr, "write");

  beforeEach(() => {
    stderrSpy.mockReset().mockImplementation(() => true);
  });

  afterEach(() => {
    delete process.env.HIVEMIND_TRACE_SQL;
    delete process.env.HIVEMIND_DEBUG;
  });

  it("writes [deeplake-sql] to stderr when HIVEMIND_TRACE_SQL=1", async () => {
    process.env.HIVEMIND_TRACE_SQL = "1";
    mockFetch.mockResolvedValueOnce(jsonResponse({ columns: ["a"], rows: [["x"]] }));
    await makeApi().query("SELECT a FROM t");
    const wrote = stderrSpy.mock.calls.some(c => String(c[0]).includes("[deeplake-sql]"));
    expect(wrote).toBe(true);
  });

  it("does not write [deeplake-sql] to stderr when trace env vars are unset", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ columns: ["a"], rows: [["x"]] }));
    await makeApi().query("SELECT a FROM t");
    const wrote = stderrSpy.mock.calls.some(c => String(c[0]).includes("[deeplake-sql]"));
    expect(wrote).toBe(false);
  });
});

// ── hasFreshLookupIndexMarker: invalid updatedAt branch ────────────────────
describe("lookup-index marker with invalid updatedAt", () => {
  it("treats marker with non-parseable updatedAt as stale (triggers CREATE INDEX again)", async () => {
    const { writeFileSync } = await import("node:fs");
    const markerDir = process.env.HIVEMIND_INDEX_MARKER_DIR!;
    const markerKey = "ws1__org1__sessions__path_creation_date";
    writeFileSync(
      join(markerDir, `${markerKey}.json`),
      JSON.stringify({ updatedAt: "not-a-date" }),
    );

    // listTables (sessions present) + SELECT info_schema (all columns present, no ALTER) + CREATE INDEX
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ tables: [{ table_name: "sessions" }] }))
      .mockResolvedValueOnce(infoSchemaResponse(allOf(SESSIONS_COLUMNS)))
      .mockResolvedValueOnce(jsonResponse({ columns: [], rows: [] }));

    const api = makeApi();
    await api.ensureSessionsTable("sessions");

    // The invalid-updatedAt marker forced ensureLookupIndex to run CREATE INDEX.
    const calls = mockFetch.mock.calls.map(c => c[1].body);
    const rebuilt = calls.some(b => String(b).includes("CREATE INDEX"));
    expect(rebuilt).toBe(true);
  });
});
