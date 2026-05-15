import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  buildPullSql,
  resolvePullDestination,
  selectLatestPerName,
  renderSkillFile,
  readLocalVersion,
  decideAction,
  fanOutSymlinks,
  runPull,
  isMissingTableError,
  isMissingContributorsColumnError,
  assertValidAuthor,
  type QueryFn,
} from "../../src/skillify/pull.js";
import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { loadManifest } from "../../src/skillify/manifest.js";

let projectRoot: string;
let projectSkillsRoot: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "skillify-pull-"));
  projectSkillsRoot = join(projectRoot, ".claude", "skills");
  // Isolate HOME so the manifest written by recordPull lands in a temp
  // directory instead of polluting the developer's real ~/.deeplake state.
  fakeHome = mkdtempSync(join(tmpdir(), "skillify-pull-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* nothing */ }
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* nothing */ }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

// ── assertValidAuthor ──────────────────────────────────────────────────────

describe("assertValidAuthor", () => {
  it("accepts emails, dotted names, and bare usernames", () => {
    expect(() => assertValidAuthor("alice@example.com")).not.toThrow();
    expect(() => assertValidAuthor("emanuele.fenocchi")).not.toThrow();
    expect(() => assertValidAuthor("d")).not.toThrow();
    expect(() => assertValidAuthor("davit-buniatyan")).not.toThrow();
    expect(() => assertValidAuthor("user_42")).not.toThrow();
  });

  it("rejects empty author", () => {
    expect(() => assertValidAuthor("")).toThrow(/empty/);
  });

  it("rejects path-traversal characters", () => {
    expect(() => assertValidAuthor("../escape")).toThrow(/invalid/);
    expect(() => assertValidAuthor("alice/bob")).toThrow(/invalid/);
    expect(() => assertValidAuthor("alice\\bob")).toThrow(/invalid/);
  });

  it("rejects whitespace and shell metacharacters", () => {
    expect(() => assertValidAuthor("alice bob")).toThrow(/invalid/);
    expect(() => assertValidAuthor("alice;rm")).toThrow(/invalid/);
    expect(() => assertValidAuthor("alice$(whoami)")).toThrow(/invalid/);
  });

  it("rejects authors longer than 64 chars", () => {
    expect(() => assertValidAuthor("a".repeat(65))).toThrow(/too long/);
  });
});

// ── buildPullSql ────────────────────────────────────────────────────────────

describe("buildPullSql", () => {
  it("emits no WHERE clause when no users / name filter", () => {
    const sql = buildPullSql({ tableName: "skills", users: [] });
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/WHERE/);
    expect(sql).toContain(`FROM "skills"`);
    expect(sql).toContain("ORDER BY project_key ASC, name ASC, version DESC");
  });

  it("filters by single user", () => {
    const sql = buildPullSql({ tableName: "skills", users: ["alice"] });
    expect(sql).toContain(`WHERE author IN ('alice')`);
  });

  it("filters by multiple users", () => {
    const sql = buildPullSql({ tableName: "skills", users: ["alice", "bob", "carol"] });
    expect(sql).toContain(`WHERE author IN ('alice', 'bob', 'carol')`);
  });

  it("filters by skill name positional", () => {
    const sql = buildPullSql({ tableName: "skills", users: [], skillName: "my-skill" });
    expect(sql).toContain(`WHERE name = 'my-skill'`);
  });

  it("AND-combines user and name filters", () => {
    const sql = buildPullSql({ tableName: "skills", users: ["alice"], skillName: "x" });
    expect(sql).toContain(`WHERE author IN ('alice') AND name = 'x'`);
  });

  it("escapes single quotes in user names and skill names", () => {
    const sql = buildPullSql({ tableName: "skills", users: ["o'malley"], skillName: "it's-tricky" });
    expect(sql).toContain(`'o''malley'`);
    expect(sql).toContain(`'it''s-tricky'`);
  });

  it("uses the provided table name (env override case)", () => {
    const sql = buildPullSql({ tableName: "skills_test", users: [] });
    expect(sql).toContain(`FROM "skills_test"`);
  });
});

// ── resolvePullDestination ─────────────────────────────────────────────────

describe("resolvePullDestination", () => {
  it("returns ~/.claude/skills for global", () => {
    expect(resolvePullDestination("global")).toBe(join(homedir(), ".claude", "skills"));
  });

  it("returns <cwd>/.claude/skills for project with cwd", () => {
    expect(resolvePullDestination("project", "/tmp/foo")).toBe("/tmp/foo/.claude/skills");
  });

  it("throws for project without cwd", () => {
    expect(() => resolvePullDestination("project")).toThrow(/requires a cwd/);
  });
});

// ── selectLatestPerName ─────────────────────────────────────────────────────

describe("selectLatestPerName (composite project_key + name key)", () => {
  it("keeps the first row per (project_key, name) — same name in different projects is preserved", () => {
    const rows = [
      { name: "deploy", project_key: "p1", version: 3 },
      { name: "deploy", project_key: "p1", version: 2 },
      { name: "deploy", project_key: "p2", version: 1 },  // SAME name, DIFFERENT project — must NOT be deduped
      { name: "build",  project_key: "p1", version: 1 },
    ];
    const out = selectLatestPerName(rows);
    expect(out).toHaveLength(3);
    // deploy@p1 (latest), then deploy@p2, then build@p1
    expect(out[0]).toMatchObject({ name: "deploy", project_key: "p1", version: 3 });
    expect(out[1]).toMatchObject({ name: "deploy", project_key: "p2", version: 1 });
    expect(out[2]).toMatchObject({ name: "build", project_key: "p1", version: 1 });
  });

  it("dedupes within a single project — keeps the highest version", () => {
    const rows = [
      { name: "a", project_key: "p", version: 5 },
      { name: "a", project_key: "p", version: 4 },
      { name: "a", project_key: "p", version: 3 },
    ];
    const out = selectLatestPerName(rows);
    expect(out).toHaveLength(1);
    expect(out[0].version).toBe(5);
  });

  it("treats missing project_key as the empty string (legacy rows still grouped)", () => {
    const rows = [
      { name: "x", version: 2 },                       // no project_key
      { name: "x", version: 1 },                       // no project_key
      { name: "x", project_key: "", version: 3 },      // explicit empty
    ];
    const out = selectLatestPerName(rows);
    expect(out).toHaveLength(1);
    expect(out[0].version).toBe(2); // first row wins (highest in DESC)
  });

  it("skips rows with empty / missing name", () => {
    const out = selectLatestPerName([
      { name: "", project_key: "p", version: 1 },
      { project_key: "p", version: 1 },
      { name: "x", project_key: "p", version: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("x");
  });

  it("returns [] for empty input", () => {
    expect(selectLatestPerName([])).toEqual([]);
  });
});

describe("isMissingTableError", () => {
  it("matches Deeplake / Postgres relation-does-not-exist", () => {
    expect(isMissingTableError(`Table does not exist: relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`relation "skills" does not exist`)).toBe(true);
    expect(isMissingTableError(`no such table: skills`)).toBe(true);
  });

  it("does NOT match generic 'does not exist' (column errors etc.)", () => {
    expect(isMissingTableError(`column "foo" does not exist`)).toBe(false);
    expect(isMissingTableError(`syntax error`)).toBe(false);
    expect(isMissingTableError(`permission denied`)).toBe(false);
  });

  it("returns false for empty / undefined", () => {
    expect(isMissingTableError(undefined)).toBe(false);
    expect(isMissingTableError("")).toBe(false);
  });

  it("does NOT false-match a missing-column error (overlaps with 'relation X does not exist')", () => {
    // The Postgres-shaped message
    //   column "contributors" of relation "skills" does not exist
    // contains `relation "skills" does not exist`, which would otherwise
    // route into the missing-table branch and silently swallow the legacy
    // table the contributors-column retry was meant to handle.
    expect(isMissingTableError(`column "contributors" of relation "skills" does not exist`)).toBe(false);
  });
});

describe("isMissingContributorsColumnError", () => {
  it("matches Postgres-shaped 'column \"contributors\" of relation \"skills\" does not exist'", () => {
    expect(isMissingContributorsColumnError(`column "contributors" of relation "skills" does not exist`)).toBe(true);
  });

  it("matches loose phrasings that mention contributors and a not-found word", () => {
    expect(isMissingContributorsColumnError(`unknown column contributors`)).toBe(true);
    expect(isMissingContributorsColumnError(`contributors not found`)).toBe(true);
  });

  it("does NOT match errors that don't mention contributors", () => {
    expect(isMissingContributorsColumnError(`column "foo" does not exist`)).toBe(false);
    expect(isMissingContributorsColumnError(`syntax error`)).toBe(false);
    expect(isMissingContributorsColumnError(`Table does not exist`)).toBe(false);
  });

  it("returns false for empty / undefined", () => {
    expect(isMissingContributorsColumnError(undefined)).toBe(false);
    expect(isMissingContributorsColumnError("")).toBe(false);
  });
});

describe("buildPullSql ORDER BY composite", () => {
  it("orders by project_key, name, version DESC", () => {
    const sql = buildPullSql({ tableName: "skills", users: [] });
    expect(sql).toContain("ORDER BY project_key ASC, name ASC, version DESC");
  });
});

describe("buildPullSql contributors column", () => {
  it("includes contributors in the SELECT by default (post-#118 schema)", () => {
    const sql = buildPullSql({ tableName: "skills", users: [] });
    expect(sql).toContain("contributors,");
  });

  it("omits contributors when includeContributors=false (legacy table fallback)", () => {
    const sql = buildPullSql({ tableName: "skills", users: [], includeContributors: false });
    expect(sql).not.toContain("contributors,");
    // Author and the rest are still present — only contributors is dropped.
    expect(sql).toContain("author, description,");
  });
});

// ── decideAction ────────────────────────────────────────────────────────────

describe("decideAction", () => {
  it("writes when local missing", () => {
    expect(decideAction({ remoteVersion: 1, localVersion: null, force: false, dryRun: false })).toBe("wrote");
  });

  it("writes when remote newer", () => {
    expect(decideAction({ remoteVersion: 3, localVersion: 2, force: false, dryRun: false })).toBe("wrote");
  });

  it("skips when local equal", () => {
    expect(decideAction({ remoteVersion: 2, localVersion: 2, force: false, dryRun: false })).toBe("skipped");
  });

  it("skips when local newer", () => {
    expect(decideAction({ remoteVersion: 1, localVersion: 5, force: false, dryRun: false })).toBe("skipped");
  });

  it("force overrides skip", () => {
    expect(decideAction({ remoteVersion: 1, localVersion: 5, force: true, dryRun: false })).toBe("wrote");
  });

  it("dry-run reports as 'dryrun' when would have written", () => {
    expect(decideAction({ remoteVersion: 1, localVersion: null, force: false, dryRun: true })).toBe("dryrun");
  });

  it("dry-run still reports skipped when local is newer", () => {
    expect(decideAction({ remoteVersion: 1, localVersion: 5, force: false, dryRun: true })).toBe("skipped");
  });
});

// ── renderSkillFile ─────────────────────────────────────────────────────────

describe("renderSkillFile", () => {
  it("renders frontmatter + body that round-trips through parseFrontmatter", () => {
    const text = renderSkillFile({
      name: "my-skill",
      description: "Does X",
      trigger_text: "When X",
      source_sessions: '["s1","s2"]',
      version: 2,
      source_agent: "claude_code",
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T01:00:00.000Z",
      body: "## Workflow\n\nDo it.",
    });
    expect(text).toContain("name: my-skill");
    expect(text).toContain(`description: "Does X"`);
    expect(text).toContain(`trigger: "When X"`);
    expect(text).toContain("version: 2");
    expect(text).toContain("created_by_agent: claude_code");
    expect(text).toContain("- s1");
    expect(text).toContain("- s2");
    expect(text).toContain("## Workflow");
  });

  it("handles array source_sessions field (already parsed)", () => {
    const text = renderSkillFile({
      name: "x", description: "", source_sessions: ["a", "b"], version: 1,
      source_agent: "x", created_at: "t", updated_at: "t", body: "b",
    });
    expect(text).toContain("- a");
    expect(text).toContain("- b");
  });

  it("falls back to empty source_sessions when field is malformed JSON", () => {
    const text = renderSkillFile({
      name: "x", description: "", source_sessions: "not json", version: 1,
      source_agent: "x", created_at: "t", updated_at: "t", body: "b",
    });
    // Frontmatter should still render — just with empty list
    expect(text).toContain("source_sessions:\n");
    expect(text).not.toContain("- not json");
  });

  it("omits trigger field when trigger_text is empty", () => {
    const text = renderSkillFile({
      name: "x", description: "", trigger_text: "", source_sessions: [], version: 1,
      source_agent: "x", created_at: "t", updated_at: "t", body: "b",
    });
    expect(text).not.toMatch(/^trigger:/m);
  });

  // Issue #118 — author + contributors persistence
  it("renders author and contributors when present on the row", () => {
    const text = renderSkillFile({
      name: "deploy", description: "d", source_sessions: [], version: 3,
      source_agent: "claude_code", created_at: "t", updated_at: "t",
      author: "alice", contributors: '["alice","emanuele"]',
      body: "b",
    });
    expect(text).toContain("author: alice");
    expect(text).toContain("contributors:\n  - alice\n  - emanuele\n");
  });

  it("falls back to [author] when contributors is empty (legacy row)", () => {
    // Legacy rows predating #118 have contributors='[]'. We render
    // contributors=[author] on disk so local consumers see a consistent
    // view from the moment the skill lands.
    const text = renderSkillFile({
      name: "x", description: "", source_sessions: [], version: 1,
      source_agent: "x", created_at: "t", updated_at: "t",
      author: "alice", contributors: "[]",
      body: "b",
    });
    expect(text).toContain("author: alice");
    expect(text).toContain("contributors:\n  - alice\n");
  });

  it("omits both fields when author is missing (very old rows)", () => {
    const text = renderSkillFile({
      name: "x", description: "", source_sessions: [], version: 1,
      source_agent: "x", created_at: "t", updated_at: "t",
      body: "b",
    });
    expect(text).not.toMatch(/^author:/m);
    expect(text).not.toMatch(/^contributors:/m);
  });
});

// ── readLocalVersion ────────────────────────────────────────────────────────

describe("readLocalVersion", () => {
  it("returns null when file missing", () => {
    expect(readLocalVersion(join(projectRoot, "nope/SKILL.md"))).toBeNull();
  });

  it("reads version from valid frontmatter", () => {
    const dir = join(projectSkillsRoot, "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: x\ndescription: "d"\nsource_sessions:\nversion: 7\ncreated_by_agent: cc\ncreated_at: 2026\nupdated_at: 2026\n---\n\nbody`);
    expect(readLocalVersion(join(dir, "SKILL.md"))).toBe(7);
  });

  it("returns null when no frontmatter", () => {
    const dir = join(projectSkillsRoot, "y");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here");
    expect(readLocalVersion(join(dir, "SKILL.md"))).toBeNull();
  });
});

// ── runPull (integration with mocked query) ────────────────────────────────

function makeMockQuery(rows: Record<string, unknown>[]): { fn: QueryFn; calls: string[] } {
  const calls: string[] = [];
  const fn: QueryFn = async (sql: string) => { calls.push(sql); return rows; };
  return { fn, calls };
}

describe("runPull", () => {
  const sampleRow = (over: Partial<Record<string, unknown>> = {}) => ({
    name: "vox-cli",
    project: "p",
    project_key: "pk",
    body: "## Workflow\n\nUse vox.",
    version: 2,
    source_agent: "claude_code",
    scope: "me",
    author: "alice",
    description: "Run vox",
    trigger_text: "Using vox",
    source_sessions: '["s1","s2"]',
    install: "global",
    created_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T01:00:00.000Z",
    ...over,
  });

  it("writes a new SKILL.md to <root>/<name>--<author>/ when local missing", async () => {
    const { fn } = makeMockQuery([sampleRow()]);  // sampleRow uses author: "alice"
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(1);
    expect(summary.skipped).toBe(0);
    // Flat layout suffixed by author keeps cross-author entries disjoint and
    // remains visible to Claude Code's single-depth skill loader.
    const path = join(projectSkillsRoot, "vox-cli--alice", "SKILL.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("version: 2");
    expect(text).toContain("Use vox");
  });

  it("skips when local version >= remote", async () => {
    const dir = join(projectSkillsRoot, "vox-cli--alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: vox-cli\ndescription: "old"\nsource_sessions:\nversion: 3\ncreated_by_agent: cc\ncreated_at: t\nupdated_at: t\n---\n\nlocal body`);
    const { fn } = makeMockQuery([sampleRow({ version: 2 })]);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("local body");
  });

  it("--force overrides skip and backs up the existing file", async () => {
    const dir = join(projectSkillsRoot, "vox-cli--alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: vox-cli\ndescription: "old"\nsource_sessions:\nversion: 5\ncreated_by_agent: cc\ncreated_at: t\nupdated_at: t\n---\n\nlocal v5 body`);
    const { fn } = makeMockQuery([sampleRow({ version: 2 })]);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: true,
    });
    expect(summary.wrote).toBe(1);
    expect(existsSync(join(dir, "SKILL.md.bak"))).toBe(true);
    expect(readFileSync(join(dir, "SKILL.md.bak"), "utf-8")).toContain("local v5 body");
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("Use vox");
  });

  it("--dry-run touches no files, reports counts", async () => {
    const { fn } = makeMockQuery([sampleRow()]);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: true, force: false,
    });
    expect(summary.dryrun).toBe(1);
    expect(summary.wrote).toBe(0);
    expect(existsSync(join(projectSkillsRoot, "vox-cli--alice"))).toBe(false);
  });

  it("dedups rows by (project_key, name) keeping latest version per project", async () => {
    const rows = [
      sampleRow({ name: "a", version: 3 }),       // project_key: "pk" (default)
      sampleRow({ name: "a", version: 2 }),       // same key — deduped
      sampleRow({ name: "b", version: 1 }),       // different name, same key
    ];
    const { fn } = makeMockQuery(rows);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary.scanned).toBe(2);
    expect(summary.wrote).toBe(2);
    const aText = readFileSync(join(projectSkillsRoot, "a--alice", "SKILL.md"), "utf-8");
    expect(aText).toContain("version: 3");
  });

  it("emits the right SQL when filtered by users + name", async () => {
    const { fn, calls } = makeMockQuery([]);
    await runPull({
      query: fn, tableName: "skills_test", install: "global",
      users: ["alice", "bob"], skillName: "vox-cli",
      dryRun: true, force: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`FROM "skills_test"`);
    expect(calls[0]).toContain(`author IN ('alice', 'bob')`);
    expect(calls[0]).toContain(`name = 'vox-cli'`);
  });

  it("treats 'Table does not exist' as an empty result (lazy-create-friendly)", async () => {
    const fn: QueryFn = async () => { throw new Error(`Table does not exist: relation "skills" does not exist`); };
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary).toEqual({ scanned: 0, wrote: 0, skipped: 0, dryrun: 0, entries: [] });
  });

  it("propagates non-missing-table errors", async () => {
    const fn: QueryFn = async () => { throw new Error(`Authentication failed: 401`); };
    await expect(runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    })).rejects.toThrow(/Authentication failed/);
  });

  it("falls back to legacy SELECT (no contributors) when the backend reports a missing column", async () => {
    // Older deployments of the skills table predate the contributors column.
    // The initial SELECT contributors,... will surface a "column does not
    // exist" error; runPull must retry once without contributors so the pull
    // still completes and we don't strand pre-#118 tables. The retried SQL
    // must NOT mention contributors — otherwise we'd loop forever on the
    // same error.
    const calls: string[] = [];
    const fn: QueryFn = async (sql: string) => {
      calls.push(sql);
      if (calls.length === 1) {
        throw new Error(`column "contributors" of relation "skills" does not exist`);
      }
      return [sampleRow()];
    };
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("contributors,");
    expect(calls[1]).not.toContain("contributors,");
    expect(summary.wrote).toBe(1);
    expect(existsSync(join(projectSkillsRoot, "vox-cli--alice", "SKILL.md"))).toBe(true);
  });

  it("keeps cross-author skills with the same name disjoint via --<author> suffix", async () => {
    const rows = [
      sampleRow({ name: "deploy", author: "alice", project_key: "alpha-key" }),
      sampleRow({ name: "deploy", author: "bob",   project_key: "beta-key" }),
    ];
    const { fn } = makeMockQuery(rows);
    await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(existsSync(join(projectSkillsRoot, "deploy--alice", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectSkillsRoot, "deploy--bob", "SKILL.md"))).toBe(true);
  });

  it("skips rows with invalid authors (path-traversal protection on the suffix segment)", async () => {
    // Different project_keys so selectLatestPerName keeps both rows.
    const rows = [
      sampleRow({ name: "deploy", project_key: "pk-bad",  author: "../escape" }),
      sampleRow({ name: "deploy", project_key: "pk-good", author: "alice" }),
    ];
    const { fn } = makeMockQuery(rows);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(1);
    expect(summary.skipped).toBe(1);
    // The valid author landed under <root>/<name>--<author>/
    expect(existsSync(join(projectSkillsRoot, "deploy--alice", "SKILL.md"))).toBe(true);
    // The invalid author would have produced "deploy--../escape" — must not exist
    expect(existsSync(join(projectSkillsRoot, "deploy--..", "escape"))).toBe(false);
  });

  it("skips rows with invalid skill names instead of writing dangerous paths", async () => {
    const rows = [
      sampleRow({ name: "../escape", project_key: "p" }),
      sampleRow({ name: "valid-skill", project_key: "p" }),
    ];
    const { fn } = makeMockQuery(rows);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    // valid-skill written, invalid one skipped (not thrown — graceful)
    expect(summary.wrote).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(existsSync(join(projectSkillsRoot, "valid-skill--alice", "SKILL.md"))).toBe(true);
    // No dangerous paths created
    expect(existsSync(join(projectSkillsRoot, "..", "escape"))).toBe(false);
  });

  it("skips rows with empty author rather than clobbering the locally-mined slot", async () => {
    // Empty author would degrade the dirName to <root>/<name>/ — exactly the
    // path locally-mined skills live in. Pulling that would silently overwrite
    // the user's own work, breaking the cross-author coexistence guarantee.
    const rows = [
      sampleRow({ name: "deploy", project_key: "pk-empty", author: "" }),
      sampleRow({ name: "deploy", project_key: "pk-valid", author: "alice" }),
    ];
    const { fn } = makeMockQuery(rows);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(1);
    expect(summary.skipped).toBe(1);
    // The empty-author row must NOT have produced <root>/deploy/SKILL.md
    expect(existsSync(join(projectSkillsRoot, "deploy", "SKILL.md"))).toBe(false);
    // The valid row landed at the suffixed path
    expect(existsSync(join(projectSkillsRoot, "deploy--alice", "SKILL.md"))).toBe(true);
    // The skipped entry carries a useful destination string for the dispatcher
    const skipped = summary.entries.find(e => e.action === "skipped");
    expect(skipped?.destination).toMatch(/empty author/i);
    expect(skipped?.author).toBe("");
  });
});

// ── fanOutSymlinks ─────────────────────────────────────────────────────────

describe("fanOutSymlinks", () => {
  it("creates symlinks pointing at canonicalDir for every existing agent root", () => {
    const canonical = join(fakeHome, ".claude", "skills", "deploy--alice");
    mkdirSync(canonical, { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");
    const hermesRoot = join(fakeHome, ".hermes", "skills");
    mkdirSync(agentsRoot, { recursive: true });
    mkdirSync(hermesRoot, { recursive: true });

    const created = fanOutSymlinks(canonical, "deploy--alice", [agentsRoot, hermesRoot]);

    expect(created).toEqual([
      join(agentsRoot, "deploy--alice"),
      join(hermesRoot, "deploy--alice"),
    ]);
    expect(lstatSync(created[0]).isSymbolicLink()).toBe(true);
    expect(readlinkSync(created[0])).toBe(canonical);
    expect(lstatSync(created[1]).isSymbolicLink()).toBe(true);
    expect(readlinkSync(created[1])).toBe(canonical);
  });

  it("is idempotent: a correctly-pointing symlink is left in place and reported as created", () => {
    const canonical = join(fakeHome, ".claude", "skills", "deploy--alice");
    mkdirSync(canonical, { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");
    mkdirSync(agentsRoot, { recursive: true });
    // First call: creates the link
    fanOutSymlinks(canonical, "deploy--alice", [agentsRoot]);
    // Second call: must not error and must still report the link
    const created = fanOutSymlinks(canonical, "deploy--alice", [agentsRoot]);
    expect(created).toEqual([join(agentsRoot, "deploy--alice")]);
  });

  it("replaces a stale symlink that points elsewhere", () => {
    const canonical = join(fakeHome, ".claude", "skills", "deploy--alice");
    const stale = join(fakeHome, "stale-target");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(stale, { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");
    mkdirSync(agentsRoot, { recursive: true });
    // Pre-existing symlink to a different target
    symlinkSync(stale, join(agentsRoot, "deploy--alice"), "dir");

    const created = fanOutSymlinks(canonical, "deploy--alice", [agentsRoot]);

    expect(created).toEqual([join(agentsRoot, "deploy--alice")]);
    expect(readlinkSync(created[0])).toBe(canonical);
  });

  it("refuses to clobber a real directory at the link path", () => {
    const canonical = join(fakeHome, ".claude", "skills", "deploy--alice");
    mkdirSync(canonical, { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");
    const conflicting = join(agentsRoot, "deploy--alice");
    mkdirSync(conflicting, { recursive: true });
    // Drop a marker file inside so we can prove it stays.
    writeFileSync(join(conflicting, "marker"), "user content");

    const created = fanOutSymlinks(canonical, "deploy--alice", [agentsRoot]);

    // Real directory left alone, not in the returned list
    expect(created).toEqual([]);
    expect(lstatSync(conflicting).isDirectory()).toBe(true);
    expect(readFileSync(join(conflicting, "marker"), "utf-8")).toBe("user content");
  });

  it("returns an empty list when no agent roots are passed", () => {
    expect(fanOutSymlinks("/whatever", "x--y", [])).toEqual([]);
  });
});

// ── runPull symlink fan-out (integration) ─────────────────────────────────

describe("runPull — symlink fan-out (global install only)", () => {
  const sampleRow = (over: Partial<Record<string, unknown>> = {}) => ({
    name: "deploy",
    project: "p",
    project_key: "pk",
    body: "## Workflow\n\nDeploy.",
    version: 1,
    source_agent: "claude_code",
    scope: "team",
    author: "alice",
    description: "Deploy skill",
    trigger_text: "When deploying",
    source_sessions: '["s1"]',
    install: "global",
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...over,
  });

  it("fans out symlinks to detected agent roots and records them in the manifest", async () => {
    // Pretend codex + hermes are installed by creating their config
    // directories — the agent-roots detector keys off these markers
    // (not on the skills subdir itself), since pi's installer never
    // creates the skills dir.
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, ".hermes"), { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");
    const hermesRoot = join(fakeHome, ".hermes", "skills");

    const { fn } = makeMockQuery([sampleRow()]);
    const summary = await runPull({
      query: fn, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(1);

    const canonical = join(fakeHome, ".claude", "skills", "deploy--alice");
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    expect(readlinkSync(join(agentsRoot, "deploy--alice"))).toBe(canonical);
    expect(readlinkSync(join(hermesRoot, "deploy--alice"))).toBe(canonical);

    const m = loadManifest();
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].symlinks).toEqual([
      join(agentsRoot, "deploy--alice"),
      join(hermesRoot, "deploy--alice"),
    ]);
  });

  it("does NOT fan out for project-install pulls (project scope shouldn't leak globally)", async () => {
    // Even with agent roots detected, a project install should not symlink
    // into ~/.agents/skills — that would expose project-local skills to
    // every project on the machine.
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const agentsRoot = join(fakeHome, ".agents", "skills");

    const { fn } = makeMockQuery([sampleRow()]);
    await runPull({
      query: fn, tableName: "skills", install: "project", cwd: projectRoot,
      users: [], dryRun: false, force: false,
    });

    expect(existsSync(join(projectSkillsRoot, "deploy--alice", "SKILL.md"))).toBe(true);
    expect(existsSync(join(agentsRoot, "deploy--alice"))).toBe(false);

    const m = loadManifest();
    expect(m.entries[0].symlinks).toEqual([]);
  });

  it("records empty symlinks[] when no agent roots are detected", async () => {
    // No ~/.agents/skills, no ~/.hermes/skills, no ~/.pi/agent/skills.
    const { fn } = makeMockQuery([sampleRow()]);
    await runPull({
      query: fn, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });
    const m = loadManifest();
    expect(m.entries[0].symlinks).toEqual([]);
  });

  it("backfill: skipped (already-up-to-date) skills get fan-out symlinks for newly installed agents", async () => {
    // Sequence we're guarding against:
    //   1. User pulls a skill (no agents installed) → SKILL.md written,
    //      symlinks: [].
    //   2. User installs codex → ~/.agents/skills now expected.
    //   3. User runs auto-pull again. Local version === remote, so
    //      decideAction returns "skipped". Without backfill, the
    //      skill stays invisible to codex forever.
    // The post-loop backfill closes this by fanning out for every
    // entry whose canonical dir exists, regardless of action.

    // Step 1: pre-pulled state — SKILL.md on disk + manifest entry
    // with symlinks: [].
    const { fn: fn1 } = makeMockQuery([sampleRow()]);
    await runPull({
      query: fn1, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });
    const m1 = loadManifest();
    expect(m1.entries[0].symlinks).toEqual([]);  // no agents, no fan-out

    // Step 2: install codex (creates the marker dir the detector keys on).
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });

    // Step 3: re-pull. Action will be "skipped" because local version
    // === remote, but backfill should refresh symlinks anyway.
    const { fn: fn2 } = makeMockQuery([sampleRow()]);
    const summary = await runPull({
      query: fn2, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });
    expect(summary.wrote).toBe(0);
    expect(summary.skipped).toBe(1);

    const m2 = loadManifest();
    expect(m2.entries).toHaveLength(1);
    expect(m2.entries[0].symlinks).toEqual([
      join(fakeHome, ".agents", "skills", "deploy--alice"),
    ]);
    // Actual symlink on disk
    expect(readlinkSync(join(fakeHome, ".agents", "skills", "deploy--alice")))
      .toBe(join(fakeHome, ".claude", "skills", "deploy--alice"));
  });

  it("backfill: skips manifest entries whose canonical dir is missing (orphan-prune territory)", async () => {
    // If a user manually rm-s the canonical dir, pruneOrphanedEntries
    // catches it at the start of the next runPull. Backfill should NOT
    // try to fan out for an entry that's about to be (or was) pruned —
    // would create a dangling symlink.

    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const { fn: fn1 } = makeMockQuery([sampleRow()]);
    await runPull({
      query: fn1, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });

    // User rm-s the canonical mid-stream.
    rmSync(join(fakeHome, ".claude", "skills", "deploy--alice"), { recursive: true });
    // And rm-s the agent symlink so we can verify it's NOT recreated.
    try { rmSync(join(fakeHome, ".agents", "skills", "deploy--alice")); } catch {}

    // Re-pull with no rows (org table empty for whatever reason).
    const { fn: fn2 } = makeMockQuery([]);
    await runPull({
      query: fn2, tableName: "skills", install: "global",
      users: [], dryRun: false, force: false,
    });

    // Manifest entry pruned by pruneOrphanedEntries; backfill saw nothing to do.
    const m = loadManifest();
    expect(m.entries).toHaveLength(0);
    // No dangling symlink recreated by backfill.
    expect(existsSync(join(fakeHome, ".agents", "skills", "deploy--alice"))).toBe(false);
  });
});
