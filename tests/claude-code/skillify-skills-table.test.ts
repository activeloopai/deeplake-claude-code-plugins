import { describe, expect, it } from "vitest";
import { insertSkillRow } from "../../src/skillify/skills-table.js";
import {
  SKILLS_COLUMNS,
  buildCreateTableSql,
  isMissingTableError,
  isMissingColumnError,
} from "../../src/deeplake-schema.js";

type Call = { sql: string };

/**
 * Programmable query mock for the worker's INSERT path.
 *
 * `script` is a list of step handlers consumed in order. Each handler
 * receives the SQL and returns either a value (rows or undefined) or
 * throws to simulate a backend error. After the script is exhausted,
 * subsequent calls succeed with `[]`.
 */
function spyQuery(script: Array<(sql: string) => unknown | Promise<unknown>> = []) {
  const calls: Call[] = [];
  let step = 0;
  const query = async (sql: string) => {
    calls.push({ sql });
    if (step < script.length) {
      const result = await script[step++](sql);
      return result ?? [];
    }
    return [];
  };
  return { calls, query };
}

/** Build a SELECT-info_schema response shape: array of `{ column_name: ... }`. */
function infoSchemaRows(present: string[]): Array<Record<string, unknown>> {
  return present.map(c => ({ column_name: c }));
}

const baseArgs = {
  tableName: "skills",
  workspaceId: "ws-1",
  name: "my-skill",
  project: "my-project",
  projectKey: "abcdef0123456789",
  localPath: "/tmp/x/.claude/skills/my-skill/SKILL.md",
  install: "project" as const,
  sourceSessions: ["s1", "s2"],
  sourceAgent: "claude_code",
  scope: "me" as const,
  author: "alice",
  contributors: ["alice"],
  description: "Does X",
  trigger: "When X",
  body: "## Workflow\n\nDo it.",
  version: 1,
  createdAt: "2026-05-06T00:00:00.000Z",
  updatedAt: "2026-05-06T00:00:00.000Z",
};

describe("insertSkillRow", () => {
  it("emits exactly one INSERT when the table exists", async () => {
    const { calls, query } = spyQuery();
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/^INSERT INTO "skills"/);
    expect(sql).toContain("'my-skill'");
    expect(sql).toContain("'my-project'");
    expect(sql).toContain("'abcdef0123456789'");
    expect(sql).toContain("'project'");          // install
    expect(sql).toContain("'claude_code'");
    expect(sql).toContain("'me'");
    expect(sql).toContain("'alice'");
    expect(sql).toContain("'Does X'");
    expect(sql).toContain("'When X'");
    expect(sql).toContain(`'["s1","s2"]'`);     // source_sessions JSON-encoded
    expect(sql).toContain(", 1, ");              // version is a bare integer, not quoted
    expect(sql).toContain("'2026-05-06T00:00:00.000Z'");
  });

  it("uses the supplied id when one is passed", async () => {
    const { calls, query } = spyQuery();
    await insertSkillRow({ query, ...baseArgs, id: "deadbeef-1234" });
    expect(calls[0].sql).toContain("'deadbeef-1234'");
  });

  it("escapes single quotes in body, description, etc.", async () => {
    const { calls, query } = spyQuery();
    await insertSkillRow({
      query, ...baseArgs,
      description: "It's tricky",
      body: "say 'hi'",
    });
    expect(calls[0].sql).toContain("'It''s tricky'");
    expect(calls[0].sql).toContain("'say ''hi'''");
  });

  it("on first INSERT failing because the table is missing: CREATE → heal pass → retry INSERT", async () => {
    // 4 calls: failed INSERT, CREATE TABLE, SELECT info_schema (heal pass —
    // covers the race where a concurrent writer pre-created a legacy
    // table, making our CREATE a no-op), then retried INSERT. The heal
    // SELECT sees the canonical column set we just created → 0 ALTERs.
    const everyCol = SKILLS_COLUMNS.map(c => c.name);
    const { calls, query } = spyQuery([
      () => { throw new Error(`Table does not exist: relation "skills" does not exist`); },
      () => undefined,                   // CREATE TABLE
      () => infoSchemaRows(everyCol),    // SELECT info_schema — schema complete
    ]);
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(4);
    expect(calls[0].sql).toMatch(/^INSERT INTO/);
    expect(calls[1].sql).toMatch(/^CREATE TABLE IF NOT EXISTS "skills"/);
    expect(calls[2].sql).toMatch(/^SELECT column_name FROM information_schema\.columns/);
    expect(calls[3].sql).toMatch(/^INSERT INTO/);
    // Retry must use the SAME insert text — same uuid is reused, etc.
    expect(calls[0].sql).toBe(calls[3].sql);
  });

  it("CREATE-then-INSERT race: lazy-create no-ops vs legacy table → heal pass adds the missing column", async () => {
    // Simulates the race CodeRabbit flagged: between our first failing
    // INSERT and our CREATE TABLE IF NOT EXISTS, another worker created
    // a legacy `skills` table without `contributors`. The CREATE
    // no-ops, the heal pass diffs against SKILLS_COLUMNS, ALTERs the
    // missing column, then retries the INSERT.
    const legacy = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const { calls, query } = spyQuery([
      () => { throw new Error(`Table does not exist: relation "skills" does not exist`); },
      () => undefined,                  // CREATE TABLE — no-op against legacy
      () => infoSchemaRows(legacy),     // SELECT info_schema — contributors missing
    ]);
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(5);
    expect(calls[0].sql).toMatch(/^INSERT INTO/);
    expect(calls[1].sql).toMatch(/^CREATE TABLE IF NOT EXISTS "skills"/);
    expect(calls[2].sql).toMatch(/^SELECT column_name FROM information_schema\.columns/);
    expect(calls[3].sql).toBe(
      `ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`,
    );
    expect(calls[4].sql).toBe(calls[0].sql);
  });

  it("does NOT lazy-create the table on a generic error (only on missing-table)", async () => {
    const { calls, query } = spyQuery([
      () => { throw new Error(`syntax error`); },
    ]);
    await expect(insertSkillRow({ query, ...baseArgs })).rejects.toThrow(/syntax error/);
    expect(calls).toHaveLength(1);
  });

  it("emits the contributors column as JSON-encoded text in the INSERT", async () => {
    const { calls, query } = spyQuery();
    await insertSkillRow({ query, ...baseArgs, contributors: ["alice", "emanuele"] });
    const sql = calls[0].sql;
    expect(sql).toMatch(/INSERT INTO "skills" \([^)]*contributors[^)]*\)/);
    expect(sql).toContain(`'["alice","emanuele"]'`);
  });

  it("heals a missing column via SELECT info_schema + targeted ALTER + retry", async () => {
    // Pre-existing table missing the `contributors` column. The heal pass
    // must: introspect the schema, see `contributors` missing, run a single
    // targeted ALTER (no IF NOT EXISTS, no blanket sweep), then retry INSERT.
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const { calls, query } = spyQuery([
      () => { throw new Error(`column "contributors" of relation "skills" does not exist`); },
      () => infoSchemaRows(existing),  // SELECT info_schema
    ]);
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(4);
    expect(calls[0].sql).toMatch(/^INSERT INTO/);
    expect(calls[1].sql).toMatch(/^SELECT column_name FROM information_schema\.columns/);
    expect(calls[1].sql).toContain(`table_name = 'skills'`);
    expect(calls[1].sql).toContain(`table_schema = 'ws-1'`);
    expect(calls[2].sql).toBe(
      `ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`,
    );
    expect(calls[3].sql).toBe(calls[0].sql);
  });

  it("heals any missing column, not just contributors", async () => {
    // Pre-existing table missing `trigger_text` (any future column added to
    // SKILLS_COLUMNS would land here the same way).
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "trigger_text");
    const { calls, query } = spyQuery([
      () => { throw new Error(`column "trigger_text" of relation "skills" does not exist`); },
      () => infoSchemaRows(existing),
    ]);
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(4);
    expect(calls[2].sql).toBe(
      `ALTER TABLE "skills" ADD COLUMN trigger_text TEXT NOT NULL DEFAULT ''`,
    );
  });

  it("heals multiple missing columns in one pass (each ALTER targeted)", async () => {
    // Old deployment missing two columns. One SELECT, two ALTERs (one per
    // missing column), then retry. ALTERs follow SKILLS_COLUMNS order.
    const existing = SKILLS_COLUMNS
      .map(c => c.name)
      .filter(c => c !== "contributors" && c !== "scope");
    const { calls, query } = spyQuery([
      () => { throw new Error(`column "scope" of relation "skills" does not exist`); },
      () => infoSchemaRows(existing),
    ]);
    await insertSkillRow({ query, ...baseArgs });

    expect(calls).toHaveLength(5);
    const alters = calls.slice(2, 4).map(c => c.sql);
    expect(alters).toEqual([
      `ALTER TABLE "skills" ADD COLUMN scope TEXT NOT NULL DEFAULT 'me'`,
      `ALTER TABLE "skills" ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`,
    ]);
    expect(calls[4].sql).toBe(calls[0].sql);
  });

  it("rethrows when missing-column error names a column NOT in SKILLS_COLUMNS", async () => {
    // If the backend reports a missing column we don't know about, the heal
    // pass finds nothing to ALTER and rethrows the original error rather
    // than looping or silently swallowing it.
    const existing = SKILLS_COLUMNS.map(c => c.name);  // schema fully present
    const { calls, query } = spyQuery([
      () => { throw new Error(`column "future_field" of relation "skills" does not exist`); },
      () => infoSchemaRows(existing),
    ]);
    await expect(insertSkillRow({ query, ...baseArgs })).rejects.toThrow(/future_field/);
    expect(calls).toHaveLength(2);  // INSERT + SELECT, no ALTER, no retry
  });

  it("tolerates a race: ALTER fails 'already exists' because another writer added the column first", async () => {
    const existing = SKILLS_COLUMNS.map(c => c.name).filter(c => c !== "contributors");
    const existingPlus = [...existing, "contributors"];
    const { calls, query } = spyQuery([
      () => { throw new Error(`column "contributors" of relation "skills" does not exist`); },
      () => infoSchemaRows(existing),
      // ALTER races with another writer
      () => { throw new Error(`column "contributors" already exists`); },
      // re-SELECT confirms the column is now present → treat as success
      () => infoSchemaRows(existingPlus),
    ]);
    await insertSkillRow({ query, ...baseArgs });

    // INSERT, SELECT, ALTER (fails race), re-SELECT (confirms), retry INSERT
    expect(calls).toHaveLength(5);
    expect(calls[4].sql).toBe(calls[0].sql);
  });

  it("does NOT lazy-ALTER on permission-denied errors", async () => {
    // permission-denied can mention 'column' but must not trigger heal —
    // re-running heal won't fix an auth problem.
    const { calls, query } = spyQuery([
      () => { throw new Error(`permission denied for column foo`); },
    ]);
    await expect(insertSkillRow({ query, ...baseArgs })).rejects.toThrow(/permission denied/);
    expect(calls).toHaveLength(1);
  });
});

describe("buildCreateTableSql(SKILLS_COLUMNS)", () => {
  it("includes every column the worker writes to", () => {
    const sql = buildCreateTableSql("skills", SKILLS_COLUMNS);
    for (const col of [
      "id", "name", "project", "project_key", "local_path", "install",
      "source_sessions", "source_agent", "scope", "author", "contributors",
      "description", "trigger_text", "body", "version", "created_at", "updated_at",
    ]) {
      expect(sql).toContain(`${col} `);
    }
    expect(sql).toContain("USING deeplake");
    expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS "skills" \(/);
  });

  it("seeds contributors with an empty JSON array literal", () => {
    expect(buildCreateTableSql("skills", SKILLS_COLUMNS))
      .toContain(`contributors TEXT NOT NULL DEFAULT '[]'`);
  });

  it("validates the table name to prevent identifier injection", () => {
    expect(() => buildCreateTableSql(`x"; DROP TABLE y; --`, SKILLS_COLUMNS)).toThrow();
  });
});

describe("error classification", () => {
  it("isMissingTableError matches table-not-found wording", () => {
    expect(isMissingTableError(`Table does not exist: relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`no such table: skills`)).toBe(true);
  });

  it("isMissingTableError does NOT match missing-column wording", () => {
    // Missing-column shape contains `relation "x" does not exist` as a substring.
    expect(isMissingTableError(`column "y" of relation "skills" does not exist`)).toBe(false);
  });

  it("isMissingTableError does NOT match permission-denied", () => {
    expect(isMissingTableError(`permission denied for table skills`)).toBe(false);
  });

  it("isMissingColumnError matches missing-column wording", () => {
    expect(isMissingColumnError(`column "contributors" of relation "skills" does not exist`)).toBe(true);
    expect(isMissingColumnError(`column "any_future" does not exist`)).toBe(true);
    expect(isMissingColumnError(`unknown column foo`)).toBe(true);
  });

  it("isMissingColumnError does NOT match permission-denied", () => {
    expect(isMissingColumnError(`permission denied for column foo`)).toBe(false);
  });

  it("isMissingColumnError does NOT match table-missing wording", () => {
    expect(isMissingColumnError(`Table does not exist: relation "skills" does not exist`)).toBe(false);
  });
});
