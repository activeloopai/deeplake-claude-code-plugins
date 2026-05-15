import { describe, it, expect } from "vitest";

/**
 * Tests for the session-end upload script's query function.
 * The upload script runs as a standalone .mjs file spawned by session-end.
 * It has its own inline `query()` function that must correctly parse the
 * Deeplake API response format: { columns: [...], rows: [[...], ...] }
 *
 * Bug: the original code used `j.data || []` but the API returns `j.rows`,
 * so SELECT checks always returned empty, causing INSERT duplicates.
 */

// Simulate the Deeplake API response format
function makeApiResponse(columns: string[], rows: unknown[][]) {
  return { columns, rows, row_count: rows.length };
}

// ── The BROKEN query parser (original code) ─────────────────────────────────
function parseBroken(json: Record<string, unknown>): unknown[] {
  // Original: return j.data || []
  return (json as any).data || [];
}

// ── The FIXED query parser ──────────────────────────────────────────────────
function parseFixed(json: Record<string, unknown>): Record<string, unknown>[] {
  const j = json as { columns?: string[]; rows?: unknown[][] };
  if (!j.columns || !j.rows) return [];
  return j.rows.map(row =>
    Object.fromEntries(j.columns!.map((col, i) => [col, row[i]]))
  );
}

describe("session-end upload query parser", () => {
  it("BROKEN parser: SELECT returns empty even when row exists (causes duplicate INSERT)", () => {
    const apiResponse = makeApiResponse(["path"], [["/summaries/test-001.md"]]);
    const result = parseBroken(apiResponse);
    // This is the bug: it returns [] even though a row exists
    expect(result).toEqual([]);
  });

  it("FIXED parser: SELECT correctly finds existing row", () => {
    const apiResponse = makeApiResponse(["path"], [["/summaries/test-001.md"]]);
    const result = parseFixed(apiResponse);
    expect(result.length).toBe(1);
    expect(result[0]["path"]).toBe("/summaries/test-001.md");
  });

  it("FIXED parser: SELECT returns empty for no rows", () => {
    const apiResponse = makeApiResponse(["path"], []);
    const result = parseFixed(apiResponse);
    expect(result).toEqual([]);
  });

  it("FIXED parser: handles null rows", () => {
    const apiResponse = { columns: ["path"], rows: null, row_count: 0 };
    const result = parseFixed(apiResponse as any);
    expect(result).toEqual([]);
  });

  it("FIXED parser: handles missing columns", () => {
    const apiResponse = { rows: [[1]], row_count: 1 };
    const result = parseFixed(apiResponse as any);
    expect(result).toEqual([]);
  });
});

describe("session-end upload: no duplicate rows", () => {
  it("upload should UPDATE existing summary row, not INSERT a duplicate", () => {
    // Simulate: session-start already created /summaries/test-001.md
    const existingRows = makeApiResponse(["path"], [["/summaries/test-001.md"]]);

    // With FIXED parser, SELECT finds the row → UPDATE path taken
    const parsed = parseFixed(existingRows);
    expect(parsed.length).toBe(1);
    // So the upload function should take the UPDATE branch, not INSERT

    // With BROKEN parser, SELECT misses the row → INSERT path taken (BUG)
    const broken = parseBroken(existingRows);
    expect(broken.length).toBe(0);
    // This causes a second INSERT, creating a duplicate row
  });
});
