/**
 * Remove skills previously installed by `hivemind skillify pull`.
 *
 * Source of truth: `~/.deeplake/state/skillify/pulled.json` (the manifest
 * written by pull.ts). Entries on disk that are NOT in the manifest are
 * never touched by default — even if their directory name follows the
 * `<name>--<author>` convention. This protects user-authored skills that
 * happen to use `--` as a naming separator (e.g. `deploy--blue-green`).
 *
 * Filtering:
 *   - by users:   --user X | --users a,b,c
 *   - by self:    --not-mine  (remove everyone-but-me; needs whoami)
 *   - default:    remove every manifest entry matching the install scope
 *   - --all:      ALSO remove flat-layout `<name>/` entries (locally-mined
 *                 skills); this path bypasses the manifest because
 *                 locally-mined skills are not tracked there. Destructive,
 *                 documented as such in usage.
 *   - --legacy-cleanup: scan disk for pre-`--author` dirs of the shape
 *                 `<16-hex>/` (old project_key layout from skillify ≤ v0.7.13)
 *                 and remove them.
 *
 * Drift handling: a manifest entry whose `installRoot/<dirName>` no longer
 * exists on disk is silently pruned from the manifest on the next unpull.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallLocation } from "./scope-config.js";
import {
  entriesForRoot, loadManifest, removePullEntry, unlinkSymlinks,
  type PulledEntry,
} from "./manifest.js";

export interface UnpullOptions {
  /** Where to scan. */
  install: InstallLocation;
  /** Used when install === "project". */
  cwd?: string;
  /** Author filter. Empty array = no filter. */
  users: string[];
  /** Username of the caller; required when notMine === true. */
  myUsername?: string;
  /** Remove entries whose author is NOT myUsername. */
  notMine?: boolean;
  /** Don't actually delete — just report. */
  dryRun?: boolean;
  /** Also remove flat-layout `<name>/` entries (locally-mined). Bypasses manifest. */
  all?: boolean;
  /** Also remove pre-`--author`-layout legacy `<projectKey>/` dirs. Bypasses manifest. */
  legacyCleanup?: boolean;
}

export interface UnpullResultEntry {
  /** Directory name as found on disk. */
  dirName: string;
  /** Source: "manifest" if the entry was pull-tracked, otherwise the disk-walk classification. */
  kind: "pulled-manifest" | "locally-mined" | "legacy-projectkey" | "manifest-orphan";
  author: string | null;
  name: string | null;
  action: "removed" | "would-remove" | "kept-filter" | "kept-policy" | "manifest-pruned";
  reason?: string;
  /** Absolute path that was (or would be) deleted, or "" for manifest-only prune. */
  path: string;
}

export interface UnpullSummary {
  scanned: number;
  removed: number;
  wouldRemove: number;
  kept: number;
  manifestPruned: number;
  entries: UnpullResultEntry[];
}

export function resolveUnpullRoot(install: InstallLocation, cwd?: string): string {
  if (install === "global") return join(homedir(), ".claude", "skills");
  if (!cwd) throw new Error("cwd required when install === 'project'");
  return join(cwd, ".claude", "skills");
}

export function runUnpull(opts: UnpullOptions): UnpullSummary {
  const root = resolveUnpullRoot(opts.install, opts.cwd);
  const summary: UnpullSummary = {
    scanned: 0, removed: 0, wouldRemove: 0, kept: 0, manifestPruned: 0, entries: [],
  };

  const userFilter = new Set(opts.users.filter(u => u.length > 0));
  const haveUserFilter = userFilter.size > 0;

  // `--all` and `--legacy-cleanup` walk the disk for entries that aren't in
  // the manifest, so they have no author metadata to filter on. Combining
  // them with an author filter would silently ignore the filter for those
  // entries — an over-removal footgun. Refuse the combination loudly and
  // make the user run two passes (one filtered, then one with --all).
  if ((opts.all || opts.legacyCleanup) && (haveUserFilter || opts.notMine)) {
    const flags = [opts.all && "--all", opts.legacyCleanup && "--legacy-cleanup"]
      .filter(Boolean).join(" / ");
    const filters = [haveUserFilter && "--user/--users", opts.notMine && "--not-mine"]
      .filter(Boolean).join(" / ");
    throw new Error(
      `${flags} cannot be combined with ${filters}: entries removed by ` +
      `${flags} are not in the manifest and have no author metadata, so ` +
      `the filter would silently fail to apply. Run the filtered unpull ` +
      `first, then ${flags} as a separate invocation.`,
    );
  }

  // ── Pass 1: manifest-driven removal of pulled entries ────────────────────
  const manifest = loadManifest();
  const entries = entriesForRoot(manifest, opts.install, root);
  for (const entry of entries) {
    summary.scanned++;
    const path = join(root, entry.dirName);

    if (!existsSync(path)) {
      // Drift: manifest says it was here, disk disagrees. Prune the entry,
      // and clean up any symlinks that may now be dangling (canonical dir
      // is gone; agent-root links recorded at pull time would point at a
      // missing target). Use the entry's own installRoot rather than the
      // resolved `root` so we drop exactly the row that pointed here, even
      // if a parallel pull wrote a same-named skill into a different
      // installRoot.
      if (!opts.dryRun) {
        unlinkSymlinks(entry.symlinks);
        removePullEntry(opts.install, entry.installRoot, entry.dirName);
      }
      summary.entries.push({
        dirName: entry.dirName,
        kind: "manifest-orphan",
        author: entry.author,
        name: entry.name,
        action: opts.dryRun ? "kept-policy" : "manifest-pruned",
        reason: opts.dryRun ? "would-prune (orphan, dir missing)" : "directory was already missing",
        path: "",
      });
      if (!opts.dryRun) summary.manifestPruned++;
      else summary.kept++;
      continue;
    }

    const decision = decideTargetForManifestEntry(entry, opts, userFilter, haveUserFilter);
    const result: UnpullResultEntry = {
      dirName: entry.dirName,
      kind: "pulled-manifest",
      author: entry.author,
      name: entry.name,
      action: "kept-policy",
      path,
    };

    if (!decision.shouldRemove) {
      result.reason = decision.reason;
      summary.kept++;
      summary.entries.push(result);
      continue;
    }

    if (opts.dryRun) {
      result.action = "would-remove";
      summary.wouldRemove++;
    } else {
      try {
        rmSync(path, { recursive: true, force: true });
        // Reverse the pull-time fan-out before dropping the manifest row:
        // once the row is gone we lose the list of agent-root links, so
        // unlink first then prune the row.
        unlinkSymlinks(entry.symlinks);
        removePullEntry(opts.install, entry.installRoot, entry.dirName);
        result.action = "removed";
        summary.removed++;
      } catch (e: any) {
        result.action = "kept-policy";
        result.reason = `rm failed: ${e?.message ?? e}`;
        summary.kept++;
      }
    }
    summary.entries.push(result);
  }

  // ── Pass 2: optional disk-walk for `--all` and `--legacy-cleanup` ───────
  // Only walk the disk when the user explicitly opts in to one of these,
  // since any matching dir here is by definition NOT in the manifest.
  if (existsSync(root) && (opts.all || opts.legacyCleanup)) {
    const manifestDirNames = new Set(entries.map(e => e.dirName));
    for (const dirName of readdirSync(root)) {
      // Already handled in pass 1.
      if (manifestDirNames.has(dirName)) continue;

      const path = join(root, dirName);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isDirectory()) continue;

      const isLegacyProjectKey = /^[0-9a-f]{16}$/.test(dirName);
      const isLocallyMined = !isLegacyProjectKey && /^[A-Za-z0-9_.-]+$/.test(dirName) && !dirName.includes("--");

      let kind: UnpullResultEntry["kind"];
      let shouldRemove = false;
      let reason: string | undefined;

      if (isLegacyProjectKey) {
        kind = "legacy-projectkey";
        if (opts.legacyCleanup) shouldRemove = true;
        else reason = "legacy project_key dir (use --legacy-cleanup)";
      } else if (isLocallyMined) {
        kind = "locally-mined";
        if (opts.all) shouldRemove = true;
        else reason = "locally-mined (use --all to remove)";
      } else {
        // Has `--` but not in manifest, or unrecognized characters: NEVER
        // touch. Most common case is a user's own variant skill like
        // `deploy--blue-green` that happens to mimic the pull naming.
        continue;
      }

      summary.scanned++;
      const result: UnpullResultEntry = {
        dirName,
        kind,
        author: null,
        name: kind === "locally-mined" ? dirName : null,
        action: "kept-policy",
        path,
        reason,
      };

      if (!shouldRemove) {
        summary.kept++;
        summary.entries.push(result);
        continue;
      }

      if (opts.dryRun) {
        result.action = "would-remove";
        summary.wouldRemove++;
      } else {
        try {
          rmSync(path, { recursive: true, force: true });
          result.action = "removed";
          summary.removed++;
        } catch (e: any) {
          result.action = "kept-policy";
          result.reason = `rm failed: ${e?.message ?? e}`;
          summary.kept++;
        }
      }
      summary.entries.push(result);
    }
  }

  return summary;
}

function decideTargetForManifestEntry(
  entry: PulledEntry,
  opts: UnpullOptions,
  userFilter: Set<string>,
  haveUserFilter: boolean,
): { shouldRemove: boolean; reason?: string } {
  if (haveUserFilter && !userFilter.has(entry.author)) {
    return { shouldRemove: false, reason: `author '${entry.author}' not in filter` };
  }
  if (opts.notMine) {
    if (!opts.myUsername) return { shouldRemove: false, reason: "--not-mine requires myUsername" };
    if (entry.author === opts.myUsername) {
      return { shouldRemove: false, reason: "your own pull (--not-mine excludes self)" };
    }
  }
  return { shouldRemove: true };
}
