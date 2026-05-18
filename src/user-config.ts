// Persistent user preferences for the plugin, stored at
// `~/.deeplake/config.json`. Separate from `~/.deeplake/credentials.json`
// (auth) — this file holds opt-in/out flags and other settings that survive
// across sessions, agents, and machines.
//
// Currently the only setting is `embeddings.enabled`, which gates whether
// capture / wiki / grep paths invoke the embed daemon. The previous
// `HIVEMIND_EMBEDDINGS=false` env var is read EXACTLY ONCE — during the
// first run of the new code on a machine that has no `embeddings.enabled`
// key yet — to seed the config, then never consulted again.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UserConfig {
  embeddings?: {
    enabled?: boolean;
  };
}

let _configPath: () => string = () =>
  process.env.HIVEMIND_CONFIG_PATH ?? join(homedir(), ".deeplake", "config.json");

// In-memory cache so the migration's env-var read and resulting write happen
// at most once per process. The file on disk is the source of truth; the
// cache only avoids re-parsing JSON on every call.
let _cache: UserConfig | null = null;
let _migrated = false;

export function readUserConfig(): UserConfig {
  if (_cache !== null) return _cache;
  const path = _configPath();
  if (!existsSync(path)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    _cache = isPlainObject(parsed) ? (parsed as UserConfig) : {};
  } catch {
    // Corrupt or unreadable — treat as empty, but DON'T overwrite (the user
    // may want to fix it by hand). A subsequent write will overwrite.
    _cache = {};
  }
  return _cache;
}

export function writeUserConfig(patch: Partial<UserConfig>): UserConfig {
  const current = readUserConfig();
  const merged = deepMerge(current, patch);
  const path = _configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  _cache = merged;
  return merged;
}

// Reads the embeddings-enabled flag, performing the one-shot env-var
// migration if no value has ever been persisted. Returns the final boolean.
//
// Migration rule (per design):
//   HIVEMIND_EMBEDDINGS=false OR unset → enabled: false
//   HIVEMIND_EMBEDDINGS=true (or any other truthy) → enabled: true
//
// Subsequent calls read straight from config; the env var is never touched
// again. `hivemind embeddings install/enable/disable/uninstall` mutate the
// config via writeUserConfig().
export function getEmbeddingsEnabled(): boolean {
  const cfg = readUserConfig();
  if (cfg.embeddings && typeof cfg.embeddings.enabled === "boolean") {
    return cfg.embeddings.enabled;
  }
  if (_migrated) {
    // Migration ran this process but couldn't persist (read-only fs etc.).
    // Fall back to the env var directly to avoid spinning the migration on
    // every call. Cached for the lifetime of the process.
    return migrationValueFromEnv();
  }
  _migrated = true;
  const enabled = migrationValueFromEnv();
  try {
    writeUserConfig({ embeddings: { enabled } });
  } catch {
    // Persist failed (perms, full disk, etc.) — keep the in-memory cache so
    // the rest of the session sees a stable value.
    _cache = { ...(cfg ?? {}), embeddings: { ...(cfg?.embeddings ?? {}), enabled } };
  }
  return enabled;
}

function migrationValueFromEnv(): boolean {
  const raw = process.env.HIVEMIND_EMBEDDINGS;
  if (raw === undefined) return false;
  if (raw === "false") return false;
  // Anything else (including "true", "1", etc.) → enabled.
  return true;
}

export function setEmbeddingsEnabled(enabled: boolean): void {
  writeUserConfig({ embeddings: { enabled } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: UserConfig, patch: Partial<UserConfig>): UserConfig {
  const out: UserConfig = { ...base };
  for (const key of Object.keys(patch) as Array<keyof UserConfig>) {
    const patchVal = patch[key];
    const baseVal = base[key];
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {
      (out as any)[key] = { ...(baseVal as object), ...(patchVal as object) };
    } else if (patchVal !== undefined) {
      (out as any)[key] = patchVal;
    }
  }
  return out;
}

// ── Test helpers ────────────────────────────────────────────────────────────

export function _setConfigPathForTesting(fn: () => string): void {
  _configPath = fn;
  _cache = null;
  _migrated = false;
}

export function _resetUserConfigForTesting(): void {
  _configPath = () =>
    process.env.HIVEMIND_CONFIG_PATH ?? join(homedir(), ".deeplake", "config.json");
  _cache = null;
  _migrated = false;
}
