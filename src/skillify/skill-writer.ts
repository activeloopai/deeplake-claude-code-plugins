/**
 * Write or merge a SKILL.md into <project>/.claude/skills/<name>/SKILL.md.
 *
 * Frontmatter shape:
 *   name: <skill-name>
 *   description: <one-line>
 *   trigger: <one-line>
 *   author: <original creator's username>
 *   source_sessions: [<uuid>, ...]
 *   contributors: [<username>, ...]      # ordered chronologically by edit
 *   version: <int, bumps on merge>
 *   created_by_agent: <agent-name>
 *   created_at: <iso>
 *   updated_at: <iso>
 *
 * Contributors model (issue #118): the `author` field is the original
 * creator's username (v=1) and never changes across merges. `contributors`
 * starts as `[author]` and gets the current editor appended on every
 * cross-author MERGE (the worker decides whether to append). Same-author
 * MERGEs do not duplicate the entry. Legacy files without these fields
 * read back as `author=undefined`, `contributors=[]`; callers fall back
 * to the `author` arg they were given when that happens.
 *
 * The body returned by the gate is written verbatim. We do not parse or
 * reformat it — the gate is responsible for shape.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillFrontmatter {
  name: string;
  description: string;
  trigger?: string;
  /** Original creator's username — set on v=1, immutable across merges. */
  author?: string;
  source_sessions: string[];
  /** Editors in order of first contribution. Includes `author` as the first entry. */
  contributors?: string[];
  version: number;
  created_by_agent: string;
  created_at: string;
  updated_at: string;
}

export interface WriteSkillArgs {
  skillsRoot: string;
  name: string;
  description: string;
  trigger?: string;
  body: string;
  sourceSessions: string[];
  agent: string;
  /**
   * Author of this fresh skill (cfg.userName in the worker). Stored as the
   * frontmatter `author` and seeds `contributors=[author]`. Empty string
   * is allowed for legacy callers / tests; we just omit the fields then.
   */
  author?: string;
}

export interface MergeSkillArgs {
  skillsRoot: string;
  name: string;            // existing skill to merge into
  description?: string;    // optional override
  body: string;            // merged body returned by gate
  newSourceSessions: string[];
  agent: string;
  /**
   * Username of whoever is performing this MERGE (cfg.userName in the
   * worker). Appended to `contributors` if not already present. Omit only
   * in legacy tests; production callers always pass it so the
   * cross-author lineage is recorded.
   */
  editor?: string;
}

export interface SkillWriteResult {
  path: string;
  action: "created" | "merged";
  version: number;
  /** ISO timestamp of the v=1 row's creation, preserved across merges. */
  createdAt: string;
  /** ISO timestamp of this write. */
  updatedAt: string;
  /** Original creator (frontmatter `author`). Undefined for legacy v=1 rows. */
  author?: string;
  /** Full contributor list after this write — caller uses it for the DB INSERT. */
  contributors: string[];
}

/**
 * Reject any name that isn't a strict kebab-case slug. The name comes from
 * model output (the gate verdict) or from a remote `skills` row pulled over
 * the network — both untrusted. Without this check, a verdict like
 * `../../etc/passwd` or `/abs/path` would escape `skillsRoot` when joined.
 *
 * Additionally guards against paths longer than 100 chars (defensive — no
 * legitimate kebab-case skill name needs more) and rejects any name
 * containing path separators even if the regex passed (belt + suspenders).
 */
export function assertValidSkillName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid skill name: empty or non-string`);
  }
  if (name.length > 100) {
    throw new Error(`invalid skill name: too long (${name.length} chars)`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid skill name: contains path separator or '..': ${name}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid skill name: must be kebab-case (lowercase a-z, 0-9, hyphen): ${name}`);
  }
}

function skillDir(skillsRoot: string, name: string): string {
  return join(skillsRoot, name);
}

function skillPath(skillsRoot: string, name: string): string {
  return join(skillDir(skillsRoot, name), "SKILL.md");
}

/** Render YAML-ish frontmatter. Conservative quoting — no embedded newlines. */
function renderFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (fm.trigger) lines.push(`trigger: ${JSON.stringify(fm.trigger)}`);
  if (fm.author) lines.push(`author: ${fm.author}`);
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions) lines.push(`  - ${s}`);
  // Render contributors only when non-empty so legacy files don't grow an
  // empty `contributors:` block on a roundtrip.
  if (fm.contributors && fm.contributors.length > 0) {
    lines.push(`contributors:`);
    for (const c of fm.contributors) lines.push(`  - ${c}`);
  }
  lines.push(`version: ${fm.version}`);
  lines.push(`created_by_agent: ${fm.created_by_agent}`);
  lines.push(`created_at: ${fm.created_at}`);
  lines.push(`updated_at: ${fm.updated_at}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse the frontmatter of an existing SKILL.md. Returns null if the file
 * has no frontmatter or is malformed — the caller treats that as "create
 * fresh, don't try to merge."
 */
export function parseFrontmatter(text: string): { fm: Partial<SkillFrontmatter>; body: string } | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const head = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Partial<SkillFrontmatter> = { source_sessions: [] };
  // arrayKey carries the current array field we're consuming. Generalizes
  // the old "sources" mode so we can also parse `contributors:` without
  // duplicating the bullet-list parsing.
  let arrayKey: "source_sessions" | "contributors" | null = null;
  for (const raw of head.split(/\r?\n/)) {
    if (arrayKey) {
      const m = raw.match(/^\s+-\s+(.+)$/);
      if (m) {
        const arr = (fm as any)[arrayKey] as string[] | undefined ?? [];
        arr.push(m[1].trim());
        (fm as any)[arrayKey] = arr;
        continue;
      }
      arrayKey = null;
    }
    if (raw.startsWith("source_sessions:")) { arrayKey = "source_sessions"; continue; }
    if (raw.startsWith("contributors:")) { arrayKey = "contributors"; fm.contributors = []; continue; }
    const m = raw.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    let val: any = v;
    if (v.startsWith("\"") && v.endsWith("\"")) {
      try { val = JSON.parse(v); } catch { /* keep as raw */ }
    } else if (k === "version") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) val = n;
    }
    (fm as any)[k] = val;
  }
  return { fm, body };
}

/** Write a new skill file. Errors if it already exists. */
export function writeNewSkill(args: WriteSkillArgs): SkillWriteResult {
  assertValidSkillName(args.name);
  const dir = skillDir(args.skillsRoot, args.name);
  const path = skillPath(args.skillsRoot, args.name);
  if (existsSync(path)) {
    throw new Error(`skill already exists at ${path}; use mergeSkill`);
  }
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  // Seed contributors with the author if one was provided. Empty / missing
  // author keeps both fields absent so legacy callers see no schema churn.
  const author = args.author && args.author.length > 0 ? args.author : undefined;
  const contributors = author ? [author] : [];
  const fm: SkillFrontmatter = {
    name: args.name,
    description: args.description,
    trigger: args.trigger,
    author,
    source_sessions: args.sourceSessions,
    contributors,
    version: 1,
    created_by_agent: args.agent,
    created_at: now,
    updated_at: now,
  };
  const text = `${renderFrontmatter(fm)}\n\n${args.body.trim()}\n`;
  writeFileSync(path, text);
  return {
    path, action: "created", version: 1,
    createdAt: now, updatedAt: now,
    author, contributors,
  };
}

/**
 * Replace an existing skill's body with a merged version, append the new
 * source sessions, and bump the version.
 */
export function mergeSkill(args: MergeSkillArgs): SkillWriteResult {
  assertValidSkillName(args.name);
  const path = skillPath(args.skillsRoot, args.name);
  if (!existsSync(path)) {
    throw new Error(`skill ${args.name} does not exist at ${path}; use writeNewSkill`);
  }
  const existing = readFileSync(path, "utf-8");
  const parsed = parseFrontmatter(existing);
  const prevVersion = (parsed?.fm.version as number) ?? 1;
  const prevSources = parsed?.fm.source_sessions ?? [];
  const merged = Array.from(new Set([...prevSources, ...args.newSourceSessions]));
  // Author is immutable across merges. If the v=1 row didn't carry one
  // (legacy), preserve absence — better than retroactively claiming the
  // editor wrote v=1.
  const author = (parsed?.fm.author as string | undefined);
  // Contributors: take what's already there (or treat legacy [] as [author]
  // if we have an author), then append the editor if not already in it.
  const prevContribs =
    parsed?.fm.contributors && parsed.fm.contributors.length > 0
      ? parsed.fm.contributors
      : (author ? [author] : []);
  const contributors = [...prevContribs];
  if (args.editor && args.editor.length > 0 && !contributors.includes(args.editor)) {
    contributors.push(args.editor);
  }
  const now = new Date().toISOString();
  const fm: SkillFrontmatter = {
    name: args.name,
    description: args.description ?? (parsed?.fm.description as string) ?? "",
    trigger: parsed?.fm.trigger as string | undefined,
    author,
    source_sessions: merged,
    contributors,
    version: prevVersion + 1,
    created_by_agent: (parsed?.fm.created_by_agent as string) ?? args.agent,
    created_at: (parsed?.fm.created_at as string) ?? now,
    updated_at: now,
  };
  const text = `${renderFrontmatter(fm)}\n\n${args.body.trim()}\n`;
  writeFileSync(path, text);
  return {
    path, action: "merged", version: fm.version,
    createdAt: fm.created_at, updatedAt: fm.updated_at,
    author, contributors,
  };
}

/**
 * List all existing skills under a skills directory (e.g. <project>/.claude/skills
 * or ~/.claude/skills), returning their full SKILL.md contents (frontmatter
 * included) so the gate can evaluate them.
 */
export function listSkills(skillsRoot: string): { name: string; body: string }[] {
  if (!existsSync(skillsRoot)) return [];
  const out: { name: string; body: string }[] = [];
  for (const name of readdirSync(skillsRoot)) {
    const skillFile = join(skillsRoot, name, "SKILL.md");
    if (existsSync(skillFile) && statSync(skillFile).isFile()) {
      out.push({ name, body: readFileSync(skillFile, "utf-8") });
    }
  }
  return out;
}

/** Compute the skills directory for a given install scope. */
export function resolveSkillsRoot(install: "project" | "global", cwd: string): string {
  if (install === "global") {
    return join(homedir(), ".claude", "skills");
  }
  return join(cwd, ".claude", "skills");
}
