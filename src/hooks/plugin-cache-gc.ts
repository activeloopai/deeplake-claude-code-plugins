#!/usr/bin/env node

/**
 * SessionEnd hook — garbage-collects old plugin version directories
 * under ~/.claude/plugins/cache/hivemind/hivemind/.
 *
 * Keeps the current version plus the next-newest (DEFAULT_KEEP_COUNT = 3),
 * so sessions that started on a previous version still find their
 * bundle until they exit — covers a session pinned through two further
 * updates. Anything older is deleted.
 *
 * Stale `.keep-<pid>` snapshots from crashed SessionStart updates are
 * also cleaned up.
 */

import { fileURLToPath } from "node:url";
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

const log = (msg: string) => _log("plugin-cache-gc", msg);
const __bundleDir = dirname(fileURLToPath(import.meta.url));

function main(): void {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const resolved = resolveVersionedPluginDir(__bundleDir);
  if (!resolved) { log("not a versioned install, skipping"); return; }

  const currentVersion = readCurrentVersionFromManifest(DEFAULT_MANIFEST_PATH);
  const plan = planGc(resolved.versionsRoot, currentVersion, DEFAULT_KEEP_COUNT);
  if (plan.deleteVersions.length === 0 && plan.deleteSnapshots.length === 0) {
    log(`nothing to gc (kept: ${plan.keep.join(", ")})`);
    return;
  }
  const result = executeGc(resolved.versionsRoot, plan);
  log(`gc kept=${result.kept.join(",")} deletedVersions=${result.deletedVersions.join(",")} deletedSnapshots=${result.deletedSnapshots.join(",")} errors=${result.errors.length}`);
}

try { main(); } catch (e: any) { log(`fatal: ${e.message}`); }
