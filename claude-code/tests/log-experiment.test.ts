import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import {
  ensureExperimentTable,
  logExperiment,
  promoteExperiment,
} from "../../src/commands/experiment-log.js";

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

function makeApi() {
  return new DeeplakeApi("tok", "https://api.test", "org1", "ws1", "");
}

beforeEach(() => mockFetch.mockReset());

// ── ensureExperimentTable ──────────────────────────────────────────────────

describe("ensureExperimentTable", () => {
  it("creates the table when missing with the generic schema", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ tables: [] }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await ensureExperimentTable(makeApi(), "experiments");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const sql = JSON.parse(mockFetch.mock.calls[1][1].body).query;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "experiments"');
    expect(sql).toContain("id TEXT");
    expect(sql).toContain("change_identifier TEXT");
    expect(sql).toContain("metric FLOAT64");
    expect(sql).toContain("metadata JSONB");
    expect(sql).toContain("status TEXT");
    expect(sql).toContain("description TEXT");
    expect(sql).toContain("global_promoted TEXT");
    expect(sql).toContain("timestamp TEXT");
    expect(sql).toContain("USING deeplake");
  });

  it("is a no-op when the table already exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ tables: [{ table_name: "experiments" }] }),
    });
    await ensureExperimentTable(makeApi(), "experiments");
    expect(mockFetch).toHaveBeenCalledTimes(1); // listTables only
  });

  it("rejects invalid table names", async () => {
    await expect(
      ensureExperimentTable(makeApi(), "drop; --"),
    ).rejects.toThrow(/Invalid SQL identifier/);
  });
});

// ── logExperiment ──────────────────────────────────────────────────────────

describe("logExperiment", () => {
  it("INSERTs a row with JSONB metadata and the expected columns", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const id = await logExperiment(makeApi(), "experiments", {
      changeIdentifier: "a1b2c3d",
      metric: 0.9979,
      status: "keep",
      description: "baseline",
      metadata: { run_tag: "c0", direction: "baseline", memory_gb: 44.0 },
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockFetch).toHaveBeenCalledOnce();

    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain('INSERT INTO "experiments"');
    expect(sql).toContain("(id, change_identifier, metric, metadata, status, description, global_promoted, timestamp)");
    expect(sql).toContain("'a1b2c3d'");
    expect(sql).toContain("0.9979");
    expect(sql).toContain("'keep'");
    expect(sql).toContain("'baseline'");
    expect(sql).toContain("::jsonb");
    expect(sql).toContain('"run_tag":"c0"');
    expect(sql).toContain('"direction":"baseline"');
    expect(sql).toContain("'no'"); // global_promoted defaults to 'no'
  });

  it("escapes single quotes in description and metadata without corrupting JSON", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await logExperiment(makeApi(), "experiments", {
      changeIdentifier: "x",
      metric: 0,
      status: "keep",
      description: "with 'quoted' word",
      metadata: { note: "it's working", ratio: 0.5 },
    });

    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    // description: ' becomes ''
    expect(sql).toContain("'with ''quoted'' word'");
    // metadata: ' inside JSON value becomes '', JSON structure stays intact
    expect(sql).toContain("''s working");
    expect(sql).toContain('"ratio":0.5');
  });

  it("defaults metadata to '{}' when omitted", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await logExperiment(makeApi(), "experiments", {
      changeIdentifier: "x",
      metric: 0,
      status: "crash",
      description: "OOM",
    });

    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("'{}'::jsonb");
  });

  it("rejects invalid table names", async () => {
    await expect(
      logExperiment(makeApi(), "drop; --", {
        changeIdentifier: "x", metric: 0, status: "keep", description: "",
      }),
    ).rejects.toThrow(/Invalid SQL identifier/);
  });
});

// ── promoteExperiment ──────────────────────────────────────────────────────

describe("promoteExperiment", () => {
  it("issues UPDATE matching change_identifier when no id is given", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await promoteExperiment(makeApi(), "experiments", {
      changeIdentifier: "a1b2c3d",
    });
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toBe(
      `UPDATE "experiments" SET global_promoted = 'yes' WHERE change_identifier = 'a1b2c3d'`,
    );
  });

  it("uses id WHERE clause when --id is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await promoteExperiment(makeApi(), "experiments", {
      changeIdentifier: "a1b2c3d",
      id: "11111111-2222-3333-4444-555555555555",
    });
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("WHERE id = '11111111-2222-3333-4444-555555555555'");
    expect(sql).not.toContain("change_identifier");
  });

  it("writes 'no' instead of 'yes' when unset is true", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await promoteExperiment(makeApi(), "experiments", {
      changeIdentifier: "a1b2c3d",
      unset: true,
    });
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("SET global_promoted = 'no'");
  });

  it("escapes single quotes in change_identifier", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await promoteExperiment(makeApi(), "experiments", {
      changeIdentifier: "evil'id",
    });
    const sql = JSON.parse(mockFetch.mock.calls[0][1].body).query;
    expect(sql).toContain("change_identifier = 'evil''id'");
  });

  it("rejects invalid table names", async () => {
    await expect(
      promoteExperiment(makeApi(), "drop; --", { changeIdentifier: "x" }),
    ).rejects.toThrow(/Invalid SQL identifier/);
  });
});
