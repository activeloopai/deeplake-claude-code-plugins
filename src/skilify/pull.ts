/**
 * Fetch skills from the Deeplake `skills` table and write them to the
 * local filesystem (project-local or global), so a teammate can install
 * skills authored by other org members.
 *
 * Read path opposite of the worker's write path:
 *   worker: gate → skill-writer (local file) → insertSkillRow (Deeplake)
 *   pull:   query Deeplake → write local SKILL.md
 *
 * Filtering:
 *   - by users:  --user X | --users a,b,c | --all-users (default)
 *   - by name:   pass a positional <skill-name> to fetch only that one
 *
 * Conflict handling:
 *   - if local SKILL.md is missing → write
 *   - if local version < remote version → backup `.bak` + overwrite
 *   - if local version >= remote version → skip (use --force to override)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertValidSkillName, parseFrontmatter, type SkillFrontmatter } from "./skill-writer.js";
import type { InstallLocation } from "./scope-config.js";

export type QueryFn = (sql: string) => Promise<Record<string, unknown>[]>;

export interface PullOptions {
  query: QueryFn;
  tableName: string;
  /** Where to write the local SKILL.md files. */
  install: InstallLocation;
  /** Used when install === "project". */
  cwd?: string;
  /** Filter by usernames. Empty array means "all users" (no author filter). */
  users: string[];
  /** Optional specific skill name (positional). */
  skillName?: string;
  /** Don't write — just report. */
  dryRun?: boolean;
  /** Overwrite even when local version >= remote. Backs up the existing file. */
  force?: boolean;
}

export interface PullResultEntry {
  name: string;
  remoteVersion: number;
  localVersion: number | null;
  /**
   * "wrote"   — file was written (was missing or remote was newer)
   * "skipped" — local already at-or-newer than remote (no --force)
   * "dryrun"  — would have written
   */
  action: "wrote" | "skipped" | "dryrun";
  destination: string;
  author: string;
  sourceAgent: string;
}

export interface PullSummary {
  scanned: number;
  wrote: number;
  skipped: number;
  dryrun: number;
  entries: PullResultEntry[];
}

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Build the SELECT SQL — public for testing so we can assert filters /
 * authoring shape without going through the network.
 */
export function buildPullSql(args: {
  tableName: string;
  users: string[];
  skillName?: string;
}): string {
  const where: string[] = [];
  if (args.users.length > 0) {
    const list = args.users.map(u => `'${esc(u)}'`).join(", ");
    where.push(`author IN (${list})`);
  }
  if (args.skillName) {
    where.push(`name = '${esc(args.skillName)}'`);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return (
    `SELECT name, project, project_key, body, version, source_agent, scope, ` +
    `author, description, trigger_text, source_sessions, install, ` +
    `created_at, updated_at ` +
    `FROM "${args.tableName}"${whereClause} ` +
    `ORDER BY project_key ASC, name ASC, version DESC`
  );
}

/**
 * Recognises the various error shapes Deeplake emits when the skills table
 * doesn't exist yet. The table is created lazily on the first INSERT, so a
 * fresh workspace's first `pull` would otherwise crash here. We treat
 * "missing table" as an empty result set — the user has nothing to pull.
 */
export function isMissingTableError(message: string | undefined): boolean {
  if (!message) return false;
  // Deeplake / Postgres-flavoured errors:
  //   "Table does not exist: relation \"skills\" does not exist"
  //   "relation \"skills\" does not exist"
  //   SQLite/local fallback variants.
  // We avoid matching the bare phrase "does not exist" alone because that
  // can legitimately appear in INSERT errors about other entities.
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}

/**
 * Resolve the directory where SKILL.md files should be written.
 * Mirror of skill-writer.resolveSkillsRoot but returns a string for testing.
 */
export function resolvePullDestination(install: InstallLocation, cwd?: string): string {
  if (install === "global") return join(homedir(), ".claude", "skills");
  if (!cwd) throw new Error("install=project requires a cwd");
  return join(cwd, ".claude", "skills");
}

/**
 * From the rows returned by the SELECT, keep only the highest-version
 * row per (project_key, name). The SQL already orders by
 * (project_key ASC, name ASC, version DESC), so the first row seen for a
 * given composite key is the latest version.
 *
 * Important: keying by name alone would silently drop one of two distinct
 * skills that happen to share a name across projects (e.g. two repos both
 * have a `deploy` skill).
 */
export function selectLatestPerName(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const name = String(r.name ?? "");
    const projectKey = String(r.project_key ?? "");
    if (!name) continue;
    const key = `${projectKey}\x00${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Render a SKILL.md from a skills-table row. Mirrors writer's frontmatter
 * shape so the pulled file is indistinguishable from a locally-generated one.
 */
export function renderSkillFile(row: Record<string, unknown>): string {
  const sources = parseSourceSessions(row.source_sessions);
  const fm: SkillFrontmatter = {
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    trigger: typeof row.trigger_text === "string" && row.trigger_text.length > 0 ? String(row.trigger_text) : undefined,
    source_sessions: sources,
    version: Number(row.version ?? 1),
    created_by_agent: String(row.source_agent ?? "unknown"),
    created_at: String(row.created_at ?? new Date().toISOString()),
    updated_at: String(row.updated_at ?? new Date().toISOString()),
  };
  const body = String(row.body ?? "").trim();
  return `${renderFrontmatter(fm)}\n\n${body}\n`;
}

function parseSourceSessions(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not JSON */ }
  }
  return [];
}

function renderFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (fm.trigger) lines.push(`trigger: ${JSON.stringify(fm.trigger)}`);
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions) lines.push(`  - ${s}`);
  lines.push(`version: ${fm.version}`);
  lines.push(`created_by_agent: ${fm.created_by_agent}`);
  lines.push(`created_at: ${fm.created_at}`);
  lines.push(`updated_at: ${fm.updated_at}`);
  lines.push("---");
  return lines.join("\n");
}

/** Read the version field of an existing local SKILL.md, or null if missing/unparseable. */
export function readLocalVersion(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const parsed = parseFrontmatter(text);
    if (!parsed) return null;
    const v = parsed.fm.version;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Decide what to do for a single remote skill row.
 * Pure function — tested directly without filesystem.
 */
export function decideAction(args: {
  remoteVersion: number;
  localVersion: number | null;
  force: boolean;
  dryRun: boolean;
}): "wrote" | "skipped" | "dryrun" {
  const shouldWrite =
    args.localVersion === null ||
    args.remoteVersion > args.localVersion ||
    args.force;
  if (!shouldWrite) return "skipped";
  return args.dryRun ? "dryrun" : "wrote";
}

/**
 * Main entry point. Queries the skills table, applies filters, decides
 * actions, and (unless dry-run) writes SKILL.md files to the destination.
 *
 * Cross-project layout: when two projects ship a skill with the same name
 * (e.g. both have `deploy`), they're written to disjoint subdirectories
 * under the install root: `<root>/<project_key>/<name>/SKILL.md`. This
 * matches the (project_key, name) uniqueness of the Deeplake table and
 * prevents cross-project overwrites.
 */
export async function runPull(opts: PullOptions): Promise<PullSummary> {
  const sql = buildPullSql({
    tableName: opts.tableName,
    users: opts.users,
    skillName: opts.skillName,
  });
  // Treat "table does not exist" as an empty result set — the table is
  // created lazily on first INSERT, so a fresh workspace has no skills yet.
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await opts.query(sql);
  } catch (e: any) {
    if (isMissingTableError(e?.message)) rows = [];
    else throw e;
  }
  const latest = selectLatestPerName(rows);

  const root = resolvePullDestination(opts.install, opts.cwd);
  const summary: PullSummary = { scanned: latest.length, wrote: 0, skipped: 0, dryrun: 0, entries: [] };

  for (const row of latest) {
    const name = String(row.name ?? "");
    if (!name) continue;
    // Validate name BEFORE constructing any path — protects against a
    // malicious or malformed `skills` row escaping the install root.
    try { assertValidSkillName(name); }
    catch (e: any) {
      summary.entries.push({
        name, remoteVersion: Number(row.version ?? 1), localVersion: null,
        action: "skipped", destination: "(invalid name — skipped)",
        author: String(row.author ?? ""), sourceAgent: String(row.source_agent ?? ""),
      });
      summary.skipped++;
      continue;
    }
    const projectKey = String(row.project_key ?? "");
    // Project subdirectory keeps cross-project skills with the same name
    // disjoint. Skip it only when project_key is empty (legacy rows).
    const skillDir = projectKey ? join(root, projectKey, name) : join(root, name);
    const skillFile = join(skillDir, "SKILL.md");
    const remoteVersion = Number(row.version ?? 1);
    const localVersion = readLocalVersion(skillFile);
    const action = decideAction({
      remoteVersion, localVersion,
      force: opts.force ?? false,
      dryRun: opts.dryRun ?? false,
    });

    if (action === "wrote") {
      mkdirSync(skillDir, { recursive: true });
      // Backup any existing file before overwriting (only if it was non-null
      // and we're actually writing).
      if (existsSync(skillFile)) {
        try { renameSync(skillFile, `${skillFile}.bak`); } catch { /* best effort */ }
      }
      writeFileSync(skillFile, renderSkillFile(row));
    }

    summary.entries.push({
      name,
      remoteVersion,
      localVersion,
      action,
      destination: skillFile,
      author: String(row.author ?? ""),
      sourceAgent: String(row.source_agent ?? ""),
    });

    if (action === "wrote") summary.wrote++;
    else if (action === "dryrun") summary.dryrun++;
    else summary.skipped++;
  }

  return summary;
}
