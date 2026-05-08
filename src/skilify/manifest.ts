/**
 * Manifest of skills installed via `hivemind skilify pull`.
 *
 * Why a manifest instead of just heuristics on directory names:
 * the `<name>--<author>/` convention used by `pull` is a legitimate
 * naming pattern that anyone can use for variant or sub-purpose skills
 * (e.g. `deploy--blue-green`, `test--integration`). Inferring "this is
 * a pull-managed entry" purely from the presence of `--` would let
 * `unpull` accidentally remove user-authored skills with that naming
 * style. The manifest gives `unpull` an authoritative list of what
 * skilify actually wrote, so anything outside that list is left alone.
 *
 * File: ~/.deeplake/state/skilify/pulled.json
 *
 * Atomicity: writes go to a sibling .tmp file and rename in place, so
 * a crash mid-write leaves either the pre-write state or the new state
 * intact (no torn JSON).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallLocation } from "./scope-config.js";

export interface PulledEntry {
  /** Directory name on disk (e.g. "meta-harness-continual-learning--d"). */
  dirName: string;
  /** Skill name (without author suffix). */
  name: string;
  /** Author who originally minted the skill. */
  author: string;
  /** Skills-table `project_key` of the source project. */
  projectKey: string;
  /** Remote version pulled (so a later pull can detect upgrade vs same). */
  remoteVersion: number;
  /** "global" → ~/.claude/skills, "project" → <cwd>/.claude/skills. */
  install: InstallLocation;
  /** Absolute install root the dir was written under. */
  installRoot: string;
  /** ISO timestamp of the pull. */
  pulledAt: string;
}

export interface PulledManifest {
  version: 1;
  entries: PulledEntry[];
}

function emptyManifest(): PulledManifest {
  return { version: 1, entries: [] };
}

export function manifestPath(): string {
  return join(homedir(), ".deeplake", "state", "skilify", "pulled.json");
}

export function loadManifest(path: string = manifestPath()): PulledManifest {
  if (!existsSync(path)) return emptyManifest();
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch { return emptyManifest(); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyManifest();
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return emptyManifest();
    // Validate each entry shape; drop malformed ones rather than failing.
    const entries: PulledEntry[] = [];
    for (const e of parsed.entries) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.dirName !== "string" || !e.dirName) continue;
      // Reject any dirName containing path separators or `..`. A corrupted
      // (or maliciously edited) manifest could otherwise convince `unpull`
      // to `rmSync(join(installRoot, dirName))` outside the install root —
      // e.g. `dirName = "../../etc"`. The pull writer always produces a
      // single-segment `<name>--<author>` string, so this validation only
      // discards entries that someone hand-edited into pulled.json.
      if (e.dirName.includes("/") || e.dirName.includes("\\") || e.dirName.includes("..")) continue;
      if (typeof e.name !== "string" || !e.name) continue;
      if (typeof e.author !== "string") continue;
      if (typeof e.installRoot !== "string" || !e.installRoot) continue;
      if (e.install !== "global" && e.install !== "project") continue;
      entries.push({
        dirName: e.dirName,
        name: e.name,
        author: e.author,
        projectKey: typeof e.projectKey === "string" ? e.projectKey : "",
        remoteVersion: typeof e.remoteVersion === "number" ? e.remoteVersion : 1,
        install: e.install,
        installRoot: e.installRoot,
        pulledAt: typeof e.pulledAt === "string" ? e.pulledAt : new Date().toISOString(),
      });
    }
    return { version: 1, entries };
  } catch {
    // Corrupt JSON — fail safe to empty manifest. Caller should not lose data
    // because the next pull will repopulate, and unpull treats missing entries
    // as "not pull-managed" (no-op).
    return emptyManifest();
  }
}

export function saveManifest(m: PulledManifest, path: string = manifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Insert or replace the entry for a given `(install, installRoot, dirName)`
 * triple. Two pulls of the same skill update the existing row's
 * `remoteVersion` + `pulledAt`. The triple is the right key because:
 *  - cross-install (global vs project) entries are independent records
 *    (same dirName can legitimately appear in both);
 *  - cross-installRoot entries are also independent — a user who pulls
 *    `deploy--alice` into `~/projA/.claude/skills` and into
 *    `~/projB/.claude/skills` must end up with TWO manifest rows, one
 *    per project root, so `unpull --to project` from each cwd only
 *    targets that cwd's entry. Keying on `(install, dirName)` alone
 *    would cause the second pull to silently overwrite the first row,
 *    and unpull would then leave the first project's directory orphaned
 *    on disk because no manifest entry pointed at it anymore.
 */
export function recordPull(entry: PulledEntry, path: string = manifestPath()): void {
  const m = loadManifest(path);
  const idx = m.entries.findIndex(e =>
    e.install === entry.install &&
    e.installRoot === entry.installRoot &&
    e.dirName === entry.dirName,
  );
  if (idx >= 0) m.entries[idx] = entry;
  else m.entries.push(entry);
  saveManifest(m, path);
}

/**
 * Remove an entry from the manifest. Idempotent — succeeds silently when
 * the entry doesn't exist (e.g. unpull called twice). Keyed by the same
 * `(install, installRoot, dirName)` triple as `recordPull` so an unpull
 * in one project cwd never accidentally drops the manifest row for an
 * identically-named skill pulled into a different project root.
 */
export function removePullEntry(
  install: InstallLocation,
  installRoot: string,
  dirName: string,
  path: string = manifestPath(),
): void {
  const m = loadManifest(path);
  const before = m.entries.length;
  m.entries = m.entries.filter(e => !(
    e.install === install &&
    e.installRoot === installRoot &&
    e.dirName === dirName
  ));
  if (m.entries.length !== before) saveManifest(m, path);
}

/**
 * Filter manifest to entries matching a specific install location and root.
 * Used by `unpull` so a `--to project` invocation only sees entries written
 * with `install === "project"` AND under the matching `installRoot`.
 */
export function entriesForRoot(m: PulledManifest, install: InstallLocation, installRoot: string): PulledEntry[] {
  return m.entries.filter(e => e.install === install && e.installRoot === installRoot);
}
