#!/usr/bin/env node

/**
 * SessionEnd hook — garbage-collects old plugin version directories
 * under ~/.claude/plugins/cache/hivemind/hivemind/.
 *
 * Keeps the current version plus the two next-newest
 * (DEFAULT_KEEP_COUNT = 3), so sessions that started on a previous
 * version still find their bundle until they exit — covers a session
 * pinned through two further updates. Anything older is deleted.
 *
 * Stale `.keep-<pid>` snapshots from crashed SessionStart updates are
 * also cleaned up.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { log as _log } from "../utils/debug.js";
import {
  DEFAULT_KEEP_COUNT,
  DEFAULT_MANIFEST_PATH,
  executeGc,
  planGc,
  readCurrentVersionFromManifest,
  resolveVersionedPluginDir,
} from "../utils/plugin-cache.js";

const defaultLog = (msg: string) => _log("plugin-cache-gc", msg);

export interface RunGcOptions {
  manifestPath?: string;
  keepCount?: number;
  log?: (msg: string) => void;
}

export function runGc(bundleDir: string, opts: RunGcOptions = {}): void {
  const log = opts.log ?? defaultLog;
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const resolved = resolveVersionedPluginDir(bundleDir);
  if (!resolved) { log("not a versioned install, skipping"); return; }

  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const keepCount = opts.keepCount ?? DEFAULT_KEEP_COUNT;
  const currentVersion = readCurrentVersionFromManifest(manifestPath);
  const plan = planGc(resolved.versionsRoot, currentVersion, keepCount);
  if (plan.deleteVersions.length === 0 && plan.deleteSnapshots.length === 0) {
    log(`nothing to gc (kept: ${plan.keep.join(", ")})`);
    return;
  }
  const result = executeGc(resolved.versionsRoot, plan);
  log(
    `gc kept=${result.kept.join(",")} `
    + `deletedVersions=${result.deletedVersions.join(",")} `
    + `deletedSnapshots=${result.deletedSnapshots.join(",")} `
    + `errors=${result.errors.length}`,
  );
}

// Only auto-run when invoked as a script (bundled entrypoint).
// Imports from tests take the `runGc` export directly and skip this.
/* c8 ignore start — script-mode bootstrap, covered by bundle integration test */
const __bundleDir = dirname(fileURLToPath(import.meta.url));
const __entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === __entryUrl) {
  try { runGc(__bundleDir); }
  catch (e: any) { defaultLog(`fatal: ${e.message}`); }
}
/* c8 ignore stop */
