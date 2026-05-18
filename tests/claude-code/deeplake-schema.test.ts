import { describe, expect, it } from "vitest";
import {
  MEMORY_COLUMNS,
  SESSIONS_COLUMNS,
  SKILLS_COLUMNS,
  buildCreateTableSql,
  healMissingColumns,
  isMissingTableError,
  isMissingColumnError,
} from "../../src/deeplake-schema.js";

/** Mock query helper: each script step is a handler that returns rows or throws. */
function mockQuery(script: Array<(sql: string) => unknown | Promise<unknown>>) {
  const calls: string[] = [];
  let step = 0;
  const query = async (sql: string) => {
    calls.push(sql);
    if (step < script.length) {
      return (await script[step++](sql)) ?? [];
    }
    return [];
  };
  return { calls, query };
}

const present = (cols: string[]) => cols.map(c => ({ column_name: c }));

describe("schema definitions", () => {
  it("MEMORY / SESSIONS / SKILLS contain only valid SQL identifiers", () => {
    for (const [label, cols] of [
      ["MEMORY_COLUMNS", MEMORY_COLUMNS],
      ["SESSIONS_COLUMNS", SESSIONS_COLUMNS],
      ["SKILLS_COLUMNS", SKILLS_COLUMNS],
    ] as const) {
      for (const c of cols) {
        expect(c.name, `${label}.${c.name}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
    }
  });

  it("every NOT NULL column has a DEFAULT (so ALTER on populated tables is safe)", () => {
    for (const [label, cols] of [
      ["MEMORY_COLUMNS", MEMORY_COLUMNS],
      ["SESSIONS_COLUMNS", SESSIONS_COLUMNS],
      ["SKILLS_COLUMNS", SKILLS_COLUMNS],
    ] as const) {
      for (const c of cols) {
        const notNull = /\bNOT\s+NULL\b/i.test(c.sql);
        const hasDefault = /\bDEFAULT\b/i.test(c.sql);
        if (notNull) {
          expect(hasDefault, `${label}.${c.name} is NOT NULL but lacks DEFAULT`).toBe(true);
        }
      }
    }
  });

  it("nullable columns (no NOT NULL) are allowed without DEFAULT", () => {
    // summary_embedding, message_embedding, message are intentionally nullable.
    const ms = MEMORY_COLUMNS.find(c => c.name === "summary_embedding");
    expect(ms?.sql).not.toMatch(/NOT NULL/);
    const me = SESSIONS_COLUMNS.find(c => c.name === "message_embedding");
    expect(me?.sql).not.toMatch(/NOT NULL/);
    const msg = SESSIONS_COLUMNS.find(c => c.name === "message");
    expect(msg?.sql).not.toMatch(/NOT NULL/);
  });
});

describe("buildCreateTableSql", () => {
  it("emits a CREATE TABLE with each column rendered as `<name> <sql>`", () => {
    const sql = buildCreateTableSql("memory", MEMORY_COLUMNS);
    expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS "memory" \(/);
    expect(sql).toContain(`id TEXT NOT NULL DEFAULT ''`);
    expect(sql).toContain(`summary_embedding FLOAT4[]`);
    expect(sql).toContain(`size_bytes BIGINT NOT NULL DEFAULT 0`);
    expect(sql).toMatch(/\) USING deeplake$/);
  });

  it("rejects table names with SQL identifier injection", () => {
    expect(() => buildCreateTableSql(`x"; DROP TABLE y; --`, SKILLS_COLUMNS)).toThrow();
  });
});

describe("healMissingColumns", () => {
  it("no-ops when every schema column is already present", async () => {
    const all = SKILLS_COLUMNS.map(c => c.name);
    const { calls, query } = mockQuery([() => present(all)]);
    const result = await healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    });
    expect(result).toEqual({ missing: [], altered: [] });
    // Only the introspection SELECT — no ALTER.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^SELECT column_name FROM information_schema\.columns/);
    expect(calls[0]).toContain(`table_schema = 'ws-1'`);
  });

  it("issues one ALTER per missing column in schema order", async () => {
    // Existing table missing `contributors` and `scope` — expect ALTERs in
    // the order they appear in SKILLS_COLUMNS (scope, then contributors).
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "scope" && c !== "contributors");
    const { calls, query } = mockQuery([() => present(existing)]);
    const result = await healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    });
    expect(result.missing).toEqual(["scope", "contributors"]);
    expect(result.altered).toEqual(["scope", "contributors"]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toBe(`ALTER TABLE "skills" ADD COLUMN scope TEXT NOT NULL DEFAULT 'me'`);
    expect(calls[2]).toBe(`ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`);
  });

  it("introspection SELECT scopes to table_schema = workspaceId", async () => {
    const existing = SKILLS_COLUMNS.map(c => c.name);
    const { calls, query } = mockQuery([() => present(existing)]);
    await healMissingColumns({
      query, tableName: "skills", workspaceId: "deadbeef-uuid", columns: SKILLS_COLUMNS,
    });
    expect(calls[0]).toContain(`table_schema = 'deadbeef-uuid'`);
    expect(calls[0]).toContain(`table_name = 'skills'`);
  });

  it("tolerates 'already exists' as a race, re-verifies with a SELECT, treats as success", async () => {
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const withContributors = [...existing, "contributors"];
    const { calls, query } = mockQuery([
      () => present(existing),
      () => { throw new Error(`column "contributors" already exists`); },
      () => present(withContributors),
    ]);
    const result = await healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    });
    // The diff knew the column was missing, but we lost the race — so
    // `missing` reflects what we tried to fix, and `altered` records what
    // we actually ran (zero, the race won).
    expect(result.missing).toEqual(["contributors"]);
    expect(result.altered).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatch(/^ALTER TABLE "skills" ADD COLUMN contributors/);
    expect(calls[2]).toMatch(/^SELECT column_name FROM information_schema\.columns/);
  });

  it("re-throws if 'already exists' fires but re-SELECT does NOT find the column", async () => {
    // Some other process emits "already exists" for a name we still can't
    // see — treat as a real failure, not a silent success.
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const { calls, query } = mockQuery([
      () => present(existing),
      () => { throw new Error(`column "contributors" already exists`); },
      () => present(existing),  // still missing
    ]);
    await expect(healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    })).rejects.toThrow(/already exists/);
    expect(calls).toHaveLength(3);
  });

  it("re-throws any non-race ALTER failure (e.g. permission denied)", async () => {
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const { calls, query } = mockQuery([
      () => present(existing),
      () => { throw new Error(`permission denied`); },
    ]);
    await expect(healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    })).rejects.toThrow(/permission denied/);
    // SELECT + failed ALTER, no further retries.
    expect(calls).toHaveLength(2);
  });

  it("case-insensitive column name match (Deeplake catalog may return lowercase)", async () => {
    // Some catalogs return column names with case differences from the
    // CREATE TABLE statement. Match must be case-insensitive on both sides.
    const upper = SKILLS_COLUMNS.map(c => c.name.toUpperCase());
    const { calls, query } = mockQuery([() => present(upper)]);
    const result = await healMissingColumns({
      query, tableName: "skills", workspaceId: "ws-1", columns: SKILLS_COLUMNS,
    });
    expect(result).toEqual({ missing: [], altered: [] });
    expect(calls).toHaveLength(1);
  });
});

describe("isMissingTableError", () => {
  it("matches every shape the backend emits", () => {
    expect(isMissingTableError(`Table does not exist: relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`no such table: skills`)).toBe(true);
  });

  it("rejects missing-column shapes (which contain `relation X does not exist` as a substring)", () => {
    expect(isMissingTableError(`column "y" of relation "skills" does not exist`)).toBe(false);
  });

  it("rejects permission-denied", () => {
    expect(isMissingTableError(`permission denied for table skills`)).toBe(false);
  });

  it("rejects empty / undefined", () => {
    expect(isMissingTableError(undefined)).toBe(false);
    expect(isMissingTableError("")).toBe(false);
  });
});

describe("isMissingColumnError", () => {
  it("matches every shape the backend emits for missing columns", () => {
    expect(isMissingColumnError(`column "contributors" of relation "skills" does not exist`)).toBe(true);
    expect(isMissingColumnError(`column "future" does not exist`)).toBe(true);
    expect(isMissingColumnError(`unknown column foo`)).toBe(true);
    expect(isMissingColumnError(`no such column: foo`)).toBe(true);
  });

  it("rejects permission-denied (even when it mentions 'column')", () => {
    expect(isMissingColumnError(`permission denied for column foo`)).toBe(false);
  });

  it("rejects table-missing wording", () => {
    expect(isMissingColumnError(`Table does not exist: relation "skills" does not exist`)).toBe(false);
  });

  it("rejects empty / undefined", () => {
    expect(isMissingColumnError(undefined)).toBe(false);
    expect(isMissingColumnError("")).toBe(false);
  });
});
