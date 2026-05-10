/**
 * Detect skill discovery roots for non-Claude agents installed on this
 * machine. Used by the pull fan-out to symlink each pulled skill into
 * every agent's native skills directory so the same canonical SKILL.md
 * (under ~/.claude/skills/) is discoverable by Codex, Hermes, and pi.
 *
 * Marker-based detection: we look for each agent's *config* directory
 * (`~/.codex`, `~/.hermes`, `~/.pi/agent`) rather than its skills
 * subdirectory. The skills dir isn't a reliable detector by itself:
 *   - codex installer creates `~/.agents/skills/` on first install,
 *     so existence of THAT path implies codex (or some agentskills.io
 *     consumer) has run.
 *   - hermes installer creates `~/.hermes/skills/hivemind-memory/`,
 *     so its skills root exists post-install.
 *   - pi installer does NOT create `~/.pi/agent/skills/` — pi
 *     populates that lazily as the user installs individual skills.
 *     So a fresh pi+hivemind box would have `~/.pi/agent/extensions/`
 *     and `~/.pi/agent/hivemind/` but no `skills/`. Existence-based
 *     detection on the skills dir would silently skip pi for this
 *     user, leaving pi without any pulled skills until they happened
 *     to mkdir it themselves.
 *
 * The Claude Code root (`~/.claude/skills/`) is excluded because the
 * canonical write location IS that path; symlinking a skill into itself
 * would be a no-op at best and a self-referential loop at worst.
 *
 * Cursor has no native skill discovery (only hooks/rules), so it is not
 * a candidate.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the list of agent skill roots that should receive a fan-out
 * symlink. Order is stable (agents → hermes → pi) for predictable test
 * assertions and deterministic manifest output.
 *
 * `~/.agents/skills/` is included whenever EITHER codex OR pi is
 * detected — both consume the agentskills.io shared layout, but only
 * codex's installer creates that directory. On a pi-only box without
 * codex, the dir wouldn't otherwise exist; we still want pi to see
 * pulled skills via that path because pi's runtime reads from it.
 * `fanOutSymlinks` upstream calls `mkdirSync(dirname(link), { recursive })`
 * before each symlink, so the directory is created on first fan-out.
 */
function resolveDetected(home: string): string[] {
  const out: string[] = [];
  const codexInstalled = existsSync(join(home, ".codex"));
  const piInstalled = existsSync(join(home, ".pi", "agent"));
  const hermesInstalled = existsSync(join(home, ".hermes"));

  // agentskills.io shared root — codex creates it, pi co-consumes it.
  if (codexInstalled || piInstalled) {
    out.push(join(home, ".agents", "skills"));
  }
  // Hermes-specific root, agentskills.io-compatible layout.
  if (hermesInstalled) {
    out.push(join(home, ".hermes", "skills"));
  }
  // Pi's primary root (pi reads from this AND ~/.agents/skills/).
  if (piInstalled) {
    out.push(join(home, ".pi", "agent", "skills"));
  }
  return out;
}

/**
 * Return absolute paths of installed non-Claude agent skill roots.
 * Filters out the canonical Claude root so we never try to symlink a
 * directory into itself when the user's `canonicalRoot` happens to
 * collide with one of the candidates.
 *
 * Pure: zero side effects, three `existsSync` calls per invocation.
 * Safe to call from any hot path (auto-pull runs it on every successful
 * pull).
 */
export function detectAgentSkillsRoots(
  canonicalRoot: string,
  home: string = homedir(),
): string[] {
  return resolveDetected(home).filter(p => p !== canonicalRoot);
}
