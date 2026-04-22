import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const KEEP_RE = /\.keep-(\d+)$/;

export function isSemver(name: string): boolean {
  return SEMVER_RE.test(name);
}

export function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

/**
 * Resolve the versioned plugin directory from the hook's bundle dir.
 *
 * Expected layout: `<cacheRoot>/plugins/cache/hivemind/hivemind/<version>/bundle/`.
 * Returns null when we're not running from that layout — e.g. a local
 * `--plugin-dir` dev run — so callers skip snapshot/restore/GC entirely.
 */
export function resolveVersionedPluginDir(bundleDir: string): {
  pluginDir: string;
  versionsRoot: string;
  version: string;
} | null {
  const pluginDir = dirname(bundleDir);
  const versionsRoot = dirname(pluginDir);
  const version = basename(pluginDir);
  if (!isSemver(version)) return null;
  if (basename(versionsRoot) !== "hivemind") return null;
  const expectedPrefix = resolve(homedir(), ".claude", "plugins", "cache") + sep;
  if (!resolve(versionsRoot).startsWith(expectedPrefix)) return null;
  return { pluginDir, versionsRoot, version };
}

function snapshotPath(pluginDir: string, pid: number): string {
  return `${pluginDir}.keep-${pid}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export interface SnapshotHandle {
  pluginDir: string;
  snapshot: string;
}

/**
 * Copy `pluginDir` to `<pluginDir>.keep-<pid>` before the installer runs.
 * Returns null when the dir doesn't exist or the copy fails — callers
 * should still run the installer; the worst case is the existing bug
 * (installer wipes the dir, we can't restore).
 */
export function snapshotPluginDir(pluginDir: string, pid = process.pid): SnapshotHandle | null {
  if (!existsSync(pluginDir)) return null;
  const snapshot = snapshotPath(pluginDir, pid);
  try {
    rmSync(snapshot, { recursive: true, force: true });
    cpSync(pluginDir, snapshot, { recursive: true, dereference: false });
    return { pluginDir, snapshot };
  } catch {
    return null;
  }
}

/**
 * After the installer runs, restore the snapshot if the installer wiped
 * the versioned directory; otherwise remove the snapshot.
 */
export function restoreOrCleanup(handle: SnapshotHandle | null): "restored" | "cleaned" | "noop" {
  if (!handle) return "noop";
  const { pluginDir, snapshot } = handle;
  try {
    if (!existsSync(pluginDir)) {
      if (existsSync(snapshot)) {
        renameSync(snapshot, pluginDir);
        return "restored";
      }
      return "noop";
    }
    rmSync(snapshot, { recursive: true, force: true });
    return "cleaned";
  } catch {
    return "noop";
  }
}

/**
 * Read the currently-installed hivemind version from Claude's plugin
 * manifest. Null when the manifest is missing or malformed.
 */
export function readCurrentVersionFromManifest(manifestPath: string): string | null {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.plugins?.["hivemind@hivemind"];
    if (!Array.isArray(entries)) return null;
    for (const e of entries) {
      if (typeof e?.version === "string" && isSemver(e.version)) return e.version;
    }
    return null;
  } catch {
    return null;
  }
}

export interface GcPlan {
  keep: string[];
  deleteVersions: string[];
  deleteSnapshots: string[];
}

/**
 * Decide which entries to keep vs delete under the versions root.
 *
 * - Keeps the current version (from the manifest) plus the next-newest
 *   versions up to `keepCount` total.
 * - Marks stale `.keep-<pid>` snapshots (dead PID) for deletion.
 * - Leaves unknown entries (non-semver, non-`.keep-*`) alone so we
 *   never touch files the installer or user put there for other reasons.
 */
export function planGc(
  versionsRoot: string,
  currentVersion: string | null,
  keepCount: number,
  isAlive: (pid: number) => boolean = isPidAlive,
): GcPlan {
  const entries = safeReaddir(versionsRoot);
  const versions = entries.filter(isSemver);
  const snapshots = entries.filter(e => KEEP_RE.test(e));

  const sorted = [...versions].sort(compareSemverDesc);
  const keep = new Set<string>();
  if (currentVersion && versions.includes(currentVersion)) keep.add(currentVersion);
  for (const v of sorted) {
    if (keep.size >= keepCount) break;
    keep.add(v);
  }

  const deleteVersions: string[] = [];
  if (currentVersion && versions.includes(currentVersion)) {
    for (const v of versions) {
      if (!keep.has(v)) deleteVersions.push(v);
    }
  }

  const deleteSnapshots: string[] = [];
  for (const s of snapshots) {
    const m = s.match(KEEP_RE);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || !isAlive(pid)) deleteSnapshots.push(s);
  }

  return { keep: [...keep], deleteVersions, deleteSnapshots };
}

export interface GcResult {
  kept: string[];
  deletedVersions: string[];
  deletedSnapshots: string[];
  errors: string[];
}

export function executeGc(versionsRoot: string, plan: GcPlan): GcResult {
  const errors: string[] = [];
  const deletedVersions: string[] = [];
  const deletedSnapshots: string[] = [];
  for (const v of plan.deleteVersions) {
    const target = join(versionsRoot, v);
    try {
      rmSync(target, { recursive: true, force: true });
      deletedVersions.push(v);
    } catch (e: any) {
      errors.push(`${v}: ${e.message}`);
    }
  }
  for (const s of plan.deleteSnapshots) {
    const target = join(versionsRoot, s);
    try {
      rmSync(target, { recursive: true, force: true });
      deletedSnapshots.push(s);
    } catch (e: any) {
      errors.push(`${s}: ${e.message}`);
    }
  }
  return { kept: plan.keep, deletedVersions, deletedSnapshots, errors };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => {
      try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

export const DEFAULT_MANIFEST_PATH = join(homedir(), ".claude", "plugins", "installed_plugins.json");
export const DEFAULT_KEEP_COUNT = 3;
