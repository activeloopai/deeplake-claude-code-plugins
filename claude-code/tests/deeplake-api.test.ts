import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
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

// ── ensureTable ─────────────────────────────────────────────────────────────

describe("DeeplakeApi.ensureTable", () => {
  it("creates table when it does not exist", async () => {
    // listTables returns empty
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    // CREATE TABLE query
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi("my_table");
    await api.ensureTable();
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(createSql).toContain("my_table");
    expect(createSql).toContain("USING deeplake");
  });

  it("does nothing when table already exists", async () => {
    // BM25 index creation is disabled (oid bug), so ensureTable only calls listTables
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "my_table" }] }),
    });
    const api = makeApi("my_table");
    await api.ensureTable();
    expect(mockFetch).toHaveBeenCalledOnce(); // only listTables, no CREATE
  });

  it("creates table with custom name", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi("default_table");
    await api.ensureTable("custom_table");
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain("custom_table");
  });

  it("reuses cached listTables across ensureTable and ensureSessionsTable", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "memory" }] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi("memory");

    await api.ensureTable();
    await api.ensureSessionsTable("sessions");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(createSql).toContain("sessions");
  });
});

// ── ensureSessionsTable ─────────────────────────────────────────────────────

describe("DeeplakeApi.ensureSessionsTable", () => {
  it("creates sessions table when it does not exist", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    const createSql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(createSql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(createSql).toContain("sessions");
    expect(createSql).toContain("JSONB");
    expect(createSql).toContain("USING deeplake");
  });

  it("does nothing when sessions table already exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "sessions" }] }),
    });
    const api = makeApi();
    await api.ensureSessionsTable("sessions");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
