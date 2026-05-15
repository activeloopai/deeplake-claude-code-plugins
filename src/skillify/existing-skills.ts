/**
 * Build the "existing skills" block the gate prompt sees, from both the
 * project-local skills root (`<cwd>/.claude/skills`) and the user-global
 * one (`~/.claude/skills`).
 *
 * Why both roots: the autopull lands pulled skills under the global root
 * regardless of scope-config, while the worker used to read only the
 * project root. That asymmetry meant the gate was making KEEP/MERGE
 * decisions blind to skills the user already had globally — the root
 * cause of cross-author duplicates (e.g. two near-identical "standup"
 * skills mined a few days apart because the gate never saw the first).
 *
 * Cross-author MERGE policy (issue #118): MERGE is now allowed on any
 * skill in the block, including ones authored by other teammates. When
 * the editor is not the original author, the worker's recordToDeeplake
 * path auto-promotes `scope` from "me" to "team" and appends the editor
 * to the `contributors` array on the v+1 row. The gate prompt declares
 * this so the LLM understands the "promotion" cost is real and only
 * picks cross-author MERGE when the new evidence genuinely extends the
 * existing skill (rather than as a default).
 */

import { listSkills, resolveSkillsRoot, parseFrontmatter } from "./skill-writer.js";

export interface TaggedSkill {
  name: string;
  body: string;
  source: "project" | "global";
  /**
   * Author parsed from the SKILL.md frontmatter. Undefined for legacy
   * files that pre-date the `author` field — the worker treats those as
   * "owned by whoever's about to edit" (same-author semantics) so a
   * legacy local file isn't accidentally treated as cross-author.
   */
  author?: string;
}

export interface ExistingSkillsBlock {
  /** Names eligible as MERGE targets. Empty when no skills exist. */
  mergeTargetNames: string[];
  /** Rendered block of all skills (project + global) for the gate prompt. */
  block: string;
}

/**
 * Collect every existing skill the gate should know about, with its
 * source root + author tagged. If a name collides across roots, the
 * project copy wins (the user is presumed to be actively editing it
 * locally).
 */
export function listAllExistingSkills(cwd: string): TaggedSkill[] {
  const projectRoot = resolveSkillsRoot("project", cwd);
  const globalRoot = resolveSkillsRoot("global", cwd);
  const tag = (source: "project" | "global") => (s: { name: string; body: string }): TaggedSkill => {
    const parsed = parseFrontmatter(s.body);
    const author = typeof parsed?.fm.author === "string" && parsed.fm.author.length > 0
      ? parsed.fm.author
      : undefined;
    return { name: s.name, body: s.body, source, author };
  };
  const tagged: TaggedSkill[] = [
    ...listSkills(projectRoot).map(tag("project")),
    ...listSkills(globalRoot).map(tag("global")),
  ];
  const seen = new Set<string>();
  const out: TaggedSkill[] = [];
  for (const s of tagged) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

/**
 * Render the gate-prompt block. `charCap` is the soft budget — once we
 * cross it, we emit a "[…N more omitted]" line and stop.
 *
 * MERGE eligibility (post-#125 review): only `[project]` skills are
 * returned in `mergeTargetNames`. A previous iteration of this PR opened
 * MERGE to every rendered skill (including `[global]`), but the worker's
 * mergeSkill path is rooted at `cfg.install` — for a `[global]` target
 * the local file doesn't exist under that root, so mergeSkill throws and
 * the fallback writes a brand-new skill (creating exactly the duplicate
 * we set out to prevent). Until the worker carries the source root
 * through the verdict and resolves a `<root>/<name>--<author>` dirname
 * for global targets, `[global]` skills stay reference-only here.
 * Tracked as a follow-up (see PR #125 description).
 *
 * Two narrower issues caught in the same review and fixed here:
 *   - `mergeTargetNames` must only include skills whose bodies were
 *     actually rendered into the prompt — otherwise the truncation tail
 *     leaks names the LLM never saw the context for.
 *   - The `[global, read-only]` tag is restored so the gate prompt's
 *     "MERGE only on [project]" rule has a stable surface to point at.
 */
export function renderExistingSkillsBlock(cwd: string, charCap: number): ExistingSkillsBlock {
  const skills = listAllExistingSkills(cwd);
  if (skills.length === 0) {
    return {
      mergeTargetNames: [],
      block: "(no existing skills — MERGE is NOT a valid choice; pick KEEP or SKIP only)",
    };
  }
  let total = 0;
  const out: string[] = [];
  const mergeTargetNames: string[] = [];
  for (const s of skills) {
    // Tag carries both the install root and the author so the gate
    // prompt can communicate "this one's yours, MERGE-eligible; this
    // one's a teammate's pulled into your global root, reference only".
    const sourceTag = s.source === "project" ? "project" : "global, read-only";
    const authorTag = s.author ? `, author=${s.author}` : "";
    const block = `--- existing skill [${sourceTag}${authorTag}]: ${s.name} ---\n${s.body}\n`;
    if (total + block.length > charCap) {
      out.push(`[…${skills.length - out.length} more existing skills omitted]`);
      break;
    }
    out.push(block);
    total += block.length;
    // Only register the name once we know the block fit and the source
    // is [project] — global skills are reference-only per the policy
    // documented above.
    if (s.source === "project") mergeTargetNames.push(s.name);
  }
  return { mergeTargetNames, block: out.join("\n") };
}
