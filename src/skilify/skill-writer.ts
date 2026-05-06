/**
 * Write or merge a SKILL.md into <project>/.claude/skills/<name>/SKILL.md.
 *
 * Frontmatter shape:
 *   name: <skill-name>
 *   description: <one-line>
 *   trigger: <one-line>
 *   source_sessions: [<uuid>, ...]
 *   version: <int, bumps on merge>
 *   created_by_agent: <agent-name>
 *   created_at: <iso>
 *   updated_at: <iso>
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
  source_sessions: string[];
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
}

export interface MergeSkillArgs {
  skillsRoot: string;
  name: string;            // existing skill to merge into
  description?: string;    // optional override
  body: string;            // merged body returned by gate
  newSourceSessions: string[];
  agent: string;
}

export interface SkillWriteResult {
  path: string;
  action: "created" | "merged";
  version: number;
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
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions) lines.push(`  - ${s}`);
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
  let mode: "kv" | "sources" = "kv";
  for (const raw of head.split(/\r?\n/)) {
    if (mode === "sources") {
      const m = raw.match(/^\s+-\s+(.+)$/);
      if (m) { fm.source_sessions!.push(m[1].trim()); continue; }
      mode = "kv";
    }
    if (raw.startsWith("source_sessions:")) {
      mode = "sources";
      continue;
    }
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
  const fm: SkillFrontmatter = {
    name: args.name,
    description: args.description,
    trigger: args.trigger,
    source_sessions: args.sourceSessions,
    version: 1,
    created_by_agent: args.agent,
    created_at: now,
    updated_at: now,
  };
  const text = `${renderFrontmatter(fm)}\n\n${args.body.trim()}\n`;
  writeFileSync(path, text);
  return { path, action: "created", version: 1 };
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
  const now = new Date().toISOString();
  const fm: SkillFrontmatter = {
    name: args.name,
    description: args.description ?? (parsed?.fm.description as string) ?? "",
    trigger: parsed?.fm.trigger as string | undefined,
    source_sessions: merged,
    version: prevVersion + 1,
    created_by_agent: (parsed?.fm.created_by_agent as string) ?? args.agent,
    created_at: (parsed?.fm.created_at as string) ?? now,
    updated_at: now,
  };
  const text = `${renderFrontmatter(fm)}\n\n${args.body.trim()}\n`;
  writeFileSync(path, text);
  return { path, action: "merged", version: fm.version };
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
