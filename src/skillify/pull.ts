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

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertValidSkillName, parseFrontmatter, type SkillFrontmatter } from "./skill-writer.js";
import type { InstallLocation } from "./scope-config.js";
import { entriesForRoot, loadManifest, pruneOrphanedEntries, recordPull } from "./manifest.js";
import { detectAgentSkillsRoots } from "./agent-roots.js";

/**
 * Tighter-than-skill-name validator for the author segment that becomes a
 * directory name (`<root>/<name>--<author>/`). Same intent as
 * `assertValidSkillName`: reject anything that could escape the install
 * root or break path-handling tools.
 */
export function assertValidAuthor(author: string): void {
  if (!author) throw new Error("author is empty");
  if (author.length > 64) throw new Error(`author too long (${author.length}): ${author.slice(0, 32)}…`);
  if (!/^[A-Za-z0-9_.\-@]+$/.test(author)) {
    throw new Error(`author contains invalid characters: ${author}`);
  }
}

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
  /**
   * Set when the SKILL.md was written successfully but the manifest
   * recording failed afterwards — surface the underlying message so the
   * caller can warn loudly. The skill exists on disk but `unpull` will
   * not be able to remove it via the manifest path, so the user must
   * either delete the dir manually or repull.
   */
  manifestError?: string;
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
 * Make `<root>/<dirName>` point at `canonicalDir` for each detected
 * non-Claude agent root. Returns the absolute paths of every symlink
 * that ended up pointing correctly (existing or newly created), in the
 * order of `agentRoots`. Caller stores this in the manifest entry so
 * unpull can reverse the fan-out without rescanning the disk.
 *
 * Refusal cases (path NOT in the returned list, no exception thrown):
 *  - A non-symlink file or directory already sits at the link path. We
 *    never clobber user data; the user gets the canonical copy under
 *    `~/.claude/skills/` and is responsible for the conflicting entry.
 *  - symlink() raises (Windows non-developer mode, read-only fs,
 *    permission denied). The skill is still on disk under the canonical
 *    location; auto-pull retries on the next session.
 *
 * Idempotency: re-running the same pull with the same agentRoots is a
 * no-op for links that already point at the right target. Stale links
 * (pointing at a different canonical path — e.g. after a HOME move) are
 * unlinked and recreated.
 */
export function fanOutSymlinks(
  canonicalDir: string,
  dirName: string,
  agentRoots: string[],
): string[] {
  const out: string[] = [];
  for (const root of agentRoots) {
    const link = join(root, dirName);
    let existing;
    try { existing = lstatSync(link); } catch { existing = null; }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        // Real file/directory at the target — never clobber. Skip silently;
        // the user can resolve the conflict by removing it and re-running pull.
        continue;
      }
      // Already a symlink. Replace only if it points elsewhere.
      let current: string | null;
      try { current = readlinkSync(link); } catch { current = null; }
      if (current === canonicalDir) {
        out.push(link);
        continue;
      }
      try { unlinkSync(link); } catch { continue; }
    }
    try {
      mkdirSync(dirname(link), { recursive: true });
      // "dir" type matters on Windows (junction vs file symlink); ignored on POSIX.
      symlinkSync(canonicalDir, link, "dir");
      out.push(link);
    } catch {
      // Best-effort. The canonical dir exists either way; skip this agent root.
    }
  }
  return out;
}

/**
 * Walk every manifest entry under `installRoot` and ensure each one has
 * fan-out symlinks pointing at the canonical dir for every currently-
 * detected agent skill root. Updates the entry's `symlinks[]` in the
 * manifest if the resolved set differs from the recorded one.
 *
 * Why this exists: the per-row fan-out inside the main pull loop only
 * runs for rows whose action is `"wrote"`. Skills already up-to-date
 * locally take the `"skipped"` path, which doesn't refresh symlinks.
 * That breaks two real scenarios:
 *
 *   1. User installs a NEW agent (codex / hermes / pi) AFTER having
 *      already pulled skills. Without backfill, those existing skills
 *      stay invisible to the new agent until each one is independently
 *      bumped on the org table.
 *   2. User manually `rm`-s a single fan-out symlink. Without backfill,
 *      it stays missing forever (or until the source row's version
 *      bumps).
 *
 * Idempotent: when the on-disk fan-out matches the recorded set,
 * skip the manifest write entirely. The hot-path cost is one
 * `lstat` per (entry × detected root) pair plus three `existsSync`
 * calls in `detectAgentSkillsRoots`. For ~50 entries × 3 roots that's
 * ~150 syscalls, negligible.
 *
 * Skips entries whose canonical dir is missing — those are pruned by
 * `pruneOrphanedEntries()` at the start of `runPull`, so by the time
 * this runs the survivors all have a real canonical dir on disk.
 */
export function backfillSymlinks(installRoot: string): void {
  const manifest = loadManifest();
  const entries = entriesForRoot(manifest, "global", installRoot);
  if (entries.length === 0) return;
  const detected = detectAgentSkillsRoots(installRoot);
  for (const entry of entries) {
    const canonical = join(entry.installRoot, entry.dirName);
    if (!existsSync(canonical)) continue; // pruned/orphan, leave alone
    const fresh = fanOutSymlinks(canonical, entry.dirName, detected);
    if (sameSorted(fresh, entry.symlinks)) continue; // no change, no write
    try {
      recordPull({ ...entry, symlinks: fresh });
    } catch {
      // Manifest write failed — leave the entry stale. Next runPull
      // will retry; the symlinks themselves are already correct on disk.
    }
  }
}

function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
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
  // Sweep stale manifest entries before fetching: anything whose canonical
  // dir was rm-ed by hand has dangling fan-out symlinks that need to go,
  // and a phantom row would otherwise survive into this pull's manifest
  // upserts. Skip on dry-run — a dry-run must not mutate disk state.
  // No-op (zero writes) when nothing is stale.
  if (!opts.dryRun) pruneOrphanedEntries();

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
    const author = String(row.author ?? "");
    // Pulled skills land at `<root>/<name>--<author>/SKILL.md` so:
    //   1. Claude Code's skill loader (single-depth scan) sees them directly
    //   2. Cross-author name collisions stay disjoint on disk
    //   3. The directory name self-documents authorship at a glance
    // Locally-mined skills stay at `<root>/<name>/` (flat, no suffix), so
    // a self-mined `deploy` and a pulled `deploy--alice` coexist.
    // Same-author / same-name across two projects is the one regression vs
    // the legacy `<projectKey>/<name>/` layout: the more recently pulled
    // row clobbers the earlier one (with `.bak` of the prior SKILL.md).
    // Acceptable trade-off — the row stays in Deeplake and is recoverable
    // via re-pull from the project that authored it.
    //
    // Empty `author` would degrade the path to `<root>/<name>/` (the
    // locally-mined slot) and silently clobber the user's own skill of
    // the same name, breaking the coexistence guarantee above. Skip the
    // row instead — Deeplake should always populate `author`, and
    // ignoring an empty one is safer than guessing a placeholder.
    if (!author) {
      summary.entries.push({
        name, remoteVersion: Number(row.version ?? 1), localVersion: null,
        action: "skipped", destination: "(empty author — skipped)",
        author: "", sourceAgent: String(row.source_agent ?? ""),
      });
      summary.skipped++;
      continue;
    }
    let dirName: string;
    try {
      assertValidAuthor(author);
      dirName = `${name}--${author}`;
    } catch (e: any) {
      summary.entries.push({
        name, remoteVersion: Number(row.version ?? 1), localVersion: null,
        action: "skipped", destination: `(invalid author '${author}' — skipped)`,
        author, sourceAgent: String(row.source_agent ?? ""),
      });
      summary.skipped++;
      continue;
    }
    const skillDir = join(root, dirName);
    const skillFile = join(skillDir, "SKILL.md");
    const remoteVersion = Number(row.version ?? 1);
    const localVersion = readLocalVersion(skillFile);
    const action = decideAction({
      remoteVersion, localVersion,
      force: opts.force ?? false,
      dryRun: opts.dryRun ?? false,
    });

    let manifestError: string | undefined;
    if (action === "wrote") {
      mkdirSync(skillDir, { recursive: true });
      // Backup any existing file before overwriting (only if it was non-null
      // and we're actually writing).
      if (existsSync(skillFile)) {
        try { renameSync(skillFile, `${skillFile}.bak`); } catch { /* best effort */ }
      }
      writeFileSync(skillFile, renderSkillFile(row));
      // Fan out symlinks into every detected non-Claude agent skills
      // root, but only for global pulls. Project-local pulls live under
      // <cwd>/.claude/skills and shouldn't leak into user-global agent
      // dirs — that would defeat the project-scoping intent.
      const symlinks = opts.install === "global"
        ? fanOutSymlinks(skillDir, dirName, detectAgentSkillsRoots(root))
        : [];
      // Record in manifest so `unpull` can identify this entry as
      // pull-managed without relying on the `--<author>` dirname heuristic
      // and so the symlinks created above can be reversed by a single
      // manifest-driven unlink pass.
      try {
        recordPull({
          dirName,
          name,
          author,
          projectKey: String(row.project_key ?? ""),
          remoteVersion,
          install: opts.install,
          installRoot: root,
          pulledAt: new Date().toISOString(),
          symlinks,
        });
      } catch (e: any) {
        // Skill is on disk but the manifest didn't record it — surface
        // this in the entry so the dispatcher can warn. `unpull` will
        // not be able to clean this entry via the manifest path until
        // a successful re-pull populates it.
        manifestError = e?.message ?? String(e);
      }
    }

    summary.entries.push({
      name,
      remoteVersion,
      localVersion,
      action,
      destination: skillFile,
      author: String(row.author ?? ""),
      sourceAgent: String(row.source_agent ?? ""),
      manifestError,
    });

    if (action === "wrote") summary.wrote++;
    else if (action === "dryrun") summary.dryrun++;
    else summary.skipped++;
  }

  // Backfill fan-out for skills that were already up-to-date this run.
  // Per-row fan-out only fires on `action === "wrote"`, so when a user
  // installs a NEW agent (codex / hermes / pi) AFTER having pulled, the
  // existing skills' canonical dirs are present but their symlinks in
  // the new agent root are missing — and they'd stay missing forever
  // because the next pull just sees `localVersion >= remoteVersion`
  // and skips. The backfill closes this gap idempotently.
  // Skip on dry-run (no disk mutations) and on project installs (no
  // fan-out for them by design).
  if (!opts.dryRun && opts.install === "global") {
    backfillSymlinks(root);
  }

  return summary;
}
