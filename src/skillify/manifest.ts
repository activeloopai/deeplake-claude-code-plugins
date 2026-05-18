/**
 * Manifest of skills installed via `hivemind skillify pull`.
 *
 * Why a manifest instead of just heuristics on directory names:
 * the `<name>--<author>/` convention used by `pull` is a legitimate
 * naming pattern that anyone can use for variant or sub-purpose skills
 * (e.g. `deploy--blue-green`, `test--integration`). Inferring "this is
 * a pull-managed entry" purely from the presence of `--` would let
 * `unpull` accidentally remove user-authored skills with that naming
 * style. The manifest gives `unpull` an authoritative list of what
 * skillify actually wrote, so anything outside that list is left alone.
 *
 * File: ~/.deeplake/state/skillify/pulled.json
 *
 * Atomicity: writes go to a sibling .tmp file and rename in place, so
 * a crash mid-write leaves either the pre-write state or the new state
 * intact (no torn JSON).
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrateLegacyStateDir } from "./legacy-migration.js";
import type { InstallLocation } from "./scope-config.js";
import { getStateDir } from "./state-dir.js";

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
  /**
   * Absolute paths of symlinks fanned out at pull time, one per detected
   * non-Claude agent root (`~/.agents/skills/<dirName>`,
   * `~/.hermes/skills/<dirName>`, …). Source of truth for `unpull` to
   * remove the links without rescanning the disk and for the orphan
   * sweep to clean up dangling links when the canonical dir is gone.
   *
   * Always absolute, never empty strings, no path traversal — same
   * defensive validation as `dirName` because a corrupted manifest could
   * otherwise convince `unpull` to `unlinkSync` arbitrary files.
   */
  symlinks: string[];
}

export interface PulledManifest {
  version: 1;
  entries: PulledEntry[];
}

function emptyManifest(): PulledManifest {
  return { version: 1, entries: [] };
}

// Routed through `getStateDir()` so the pulled-skills manifest lives next
// to the rest of skillify state (`HIVEMIND_STATE_DIR`-aware). Without
// this, tests that called `recordPull` / `unlinkSymlinks` would still
// write `pulled.json` into the developer's real `~/.deeplake` while the
// lock and counter state landed in the tmp dir — inconsistent state
// across the same directory tree.
export function manifestPath(): string {
  return join(getStateDir(), "pulled.json");
}

export function loadManifest(path: string = manifestPath()): PulledManifest {
  migrateLegacyStateDir();
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
      // Validate symlinks list. Every entry must be (a) a string, (b)
      // absolute, and (c) free of `..` traversal. Anything else is dropped
      // silently — same defensive posture as the dirName validator above:
      // a corrupted manifest must not let `unpull` unlink arbitrary paths.
      // A missing/wrong-type field becomes an empty array (back-compat with
      // manifests written before symlink fan-out existed).
      const symlinks: string[] = Array.isArray(e.symlinks)
        ? e.symlinks.filter(
            (p: unknown): p is string =>
              typeof p === "string" &&
              p.length > 0 &&
              (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) && // absolute (POSIX or Windows)
              !p.includes(".."),
          )
        : [];
      entries.push({
        dirName: e.dirName,
        name: e.name,
        author: e.author,
        projectKey: typeof e.projectKey === "string" ? e.projectKey : "",
        remoteVersion: typeof e.remoteVersion === "number" ? e.remoteVersion : 1,
        install: e.install,
        installRoot: e.installRoot,
        pulledAt: typeof e.pulledAt === "string" ? e.pulledAt : new Date().toISOString(),
        symlinks,
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
  migrateLegacyStateDir();
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

/**
 * Best-effort unlink of every recorded fan-out symlink. Anything that is
 * NOT a symbolic link at the recorded path is left untouched — the user
 * may have replaced it after the pull, and an old manifest record isn't
 * authority enough to delete user content.
 *
 * Per-path failures don't propagate; a stuck link is preferable to
 * leaving a manifest entry that points at a path the cleanup couldn't
 * reach. Caller drops the manifest row regardless.
 */
export function unlinkSymlinks(paths: readonly string[]): void {
  for (const path of paths) {
    let st;
    try { st = lstatSync(path); } catch { continue; }   // already gone
    if (!st.isSymbolicLink()) continue;                 // user-replaced, leave alone
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

/**
 * Walk the full manifest and prune any entry whose `installRoot/dirName`
 * no longer exists on disk. Useful at the start of `runPull` to clean up
 * after a user who `rm -rf`-ed a canonical skill dir by hand: the entry's
 * recorded fan-out symlinks would now be dangling, the manifest row
 * would be a phantom, and unpull (filter-aware) wouldn't visit it.
 *
 * Returns the number of entries pruned. Idempotent: zero entries pruned
 * means zero disk writes (saveManifest only fires when something
 * actually changed).
 */
export function pruneOrphanedEntries(path: string = manifestPath()): number {
  const m = loadManifest(path);
  const live: PulledEntry[] = [];
  let pruned = 0;
  for (const e of m.entries) {
    if (existsSync(join(e.installRoot, e.dirName))) {
      live.push(e);
      continue;
    }
    // Canonical dir is gone — cleanup any dangling symlinks recorded for
    // this entry, then drop the row.
    unlinkSymlinks(e.symlinks);
    pruned++;
  }
  if (pruned > 0) saveManifest({ version: 1, entries: live }, path);
  return pruned;
}
