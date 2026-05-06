/**
 * Persisted scope + team membership for the skilify worker.
 *
 * File: ~/.deeplake/state/skilify/config.json
 *   { scope: "me" | "team" | "org", team: string[] }
 *
 * Defaults to scope "me" with an empty team list when the file is absent
 * or unreadable. The `hivemind skilify` CLI (src/commands/skilify.ts) is
 * the only writer; the worker hook reads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Scope = "me" | "team" | "org";
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

const STATE_DIR = join(homedir(), ".deeplake", "state", "skilify");
const CONFIG_PATH = join(STATE_DIR, "config.json");

const DEFAULT: ScopeConfig = { scope: "me", team: [], install: "project" };

export function loadScopeConfig(): ScopeConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const scope: Scope = raw.scope === "team" || raw.scope === "org" ? raw.scope : "me";
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
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
