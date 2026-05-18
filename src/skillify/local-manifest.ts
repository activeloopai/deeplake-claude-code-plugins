/**
 * Shared accessor for the `mine-local` manifest at
 * ~/.claude/hivemind/local-mined.json.
 *
 * The manifest does triple duty:
 *   1. One-shot sentinel — `hivemind skillify mine-local` refuses to
 *      re-run when the file exists (unless `--force` is passed).
 *   2. Provenance index — records every locally-mined skill's canonical
 *      path, source sessions, fan-out symlinks, and gate metadata for a
 *      future `push-local` flow (uploads `uploaded:false` rows after
 *      sign-in).
 *   3. Read-only hint surface — the per-agent SessionStart hooks read
 *      the entry count when no credentials are present and surface it
 *      as part of the "not logged in" injection: "You have N local
 *      skills. Sign in to share new ones."
 *
 * Pulled out of `src/commands/mine-local.ts` so the session-start hooks
 * don't have to depend on the CLI orchestrator (which transitively
 * imports the gate runner, parallelMap, etc. — heavy for a hook).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalManifestEntry {
  skill_name: string;
  canonical_path: string;
  /** Symlink targets created in other agents' skill roots. */
  symlinks: string[];
  source_session_ids: string[];
  source_session_paths: string[];
  source_agent: string;
  gate_agent: string;
  created_at: string;
  /** False until a future `push-local` flow uploads the row to the org table. */
  uploaded: boolean;
}

export interface LocalManifest {
  created_at: string;
  entries: LocalManifestEntry[];
}

export const LOCAL_MANIFEST_PATH = join(homedir(), ".claude", "hivemind", "local-mined.json");

/**
 * Sibling lock file used by maybeAutoMineLocal() (spawn-mine-local-worker.ts)
 * and released by runMineLocal() on exit. Exported here so both producers
 * agree on the path without circular imports.
 */
export const LOCAL_MINE_LOCK_PATH = join(homedir(), ".claude", "hivemind", "local-mined.lock");

/**
 * Read the manifest. Returns null when the file doesn't exist or is
 * malformed. `path` defaults to LOCAL_MANIFEST_PATH; tests inject a
 * tmpdir path so they don't have to mutate the developer's HOME.
 */
export function readLocalManifest(path: string = LOCAL_MANIFEST_PATH): LocalManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LocalManifest;
  } catch {
    return null;
  }
}

/** Write the manifest, creating parent directories as needed. */
export function writeLocalManifest(m: LocalManifest, path: string = LOCAL_MANIFEST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2));
}

/**
 * Cheap accessor for the SessionStart hook — returns the count of locally
 * mined skills without forcing callers to handle null/error branches.
 * Returns 0 if the manifest is missing, malformed, or has no entries.
 */
export function countLocalManifestEntries(path: string = LOCAL_MANIFEST_PATH): number {
  const m = readLocalManifest(path);
  // Defend against malformed manifests where `entries` is present but not
  // an array (e.g. a string like "oops" would otherwise leak `.length`).
  return Array.isArray(m?.entries) ? m!.entries.length : 0;
}
