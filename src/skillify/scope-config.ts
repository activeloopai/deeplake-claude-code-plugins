/**
 * Persisted scope + team membership for the skillify worker.
 *
 * File: ~/.deeplake/state/skillify/config.json
 *   { scope: "me" | "team", team: string[] }
 *
 * Defaults to scope "me" with an empty team list when the file is absent
 * or unreadable. The `hivemind skillify` CLI (src/commands/skillify.ts) is
 * the only writer; the worker hook reads.
 *
 * Legacy compat: the product surface used to include a third value
 * `scope = "org"` (no author filter, mine from every workspace user).
 * The CLI no longer accepts it, but config files that already set it
 * are silently coerced to `"team"` on read so users who ran `hivemind
 * skillify scope org` once don't get a hard failure on next session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyStateDir } from "./legacy-migration.js";
import { getStateDir } from "./state-dir.js";

export type Scope = "me" | "team";
export type InstallLocation = "project" | "global";

export interface ScopeConfig {
  scope: Scope;
  team: string[];
  /**
   * Where the worker writes generated skills:
   *   "project" → <cwd>/.claude/skills/<name>/SKILL.md   (default; lives with the repo)
   *   "global"  → ~/.claude/skills/<name>/SKILL.md       (visible across all projects)
   */
  install: InstallLocation;
}

// Resolved per call so `HIVEMIND_STATE_DIR` redirects from tests and
// alternate installs land in the same dir as the worker's lock/state files
// instead of leaking into the developer's real `~/.deeplake`.
function configPath(): string {
  return join(getStateDir(), "config.json");
}

const DEFAULT: ScopeConfig = { scope: "me", team: [], install: "project" };

export function loadScopeConfig(): ScopeConfig {
  migrateLegacyStateDir();
  const CONFIG_PATH = configPath();
  if (!existsSync(CONFIG_PATH)) return DEFAULT;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Silent legacy coercion: `"org"` was a third scope value we removed
    // when narrowing the product surface to me|team. Treating a stale
    // `"org"` config as `"team"` keeps existing users working without
    // forcing them to re-run `hivemind skillify scope`.
    const scope: Scope =
      raw.scope === "team" ? "team"
        : raw.scope === "org" ? "team"
          : "me";
    const team: string[] = Array.isArray(raw.team)
      ? raw.team.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const install: InstallLocation = raw.install === "global" ? "global" : "project";
    return { scope, team, install };
  } catch {
    return DEFAULT;
  }
}

export function saveScopeConfig(cfg: ScopeConfig): void {
  migrateLegacyStateDir();
  mkdirSync(getStateDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
