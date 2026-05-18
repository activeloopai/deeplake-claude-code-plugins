/**
 * One-time migration of the pre-rename state directory.
 *
 * Old: ~/.deeplake/state/skilify/
 * New: ~/.deeplake/state/skillify/
 *
 * If the legacy directory exists and the new one does not, rename in place
 * so installed-skill manifests, scope config, and per-project state survive
 * the rename.
 *
 * Env-awareness: the *new* directory is resolved through `getStateDir()`,
 * which honors `HIVEMIND_STATE_DIR`. The legacy sibling is computed as the
 * `skilify` sibling of whatever `getStateDir()` returns. When tests point
 * `HIVEMIND_STATE_DIR` at a `mkdtempSync()` dir, the `skilify` sibling
 * obviously does not exist — the migration short-circuits, which is the
 * whole point: tests must never touch the developer's real
 * `~/.deeplake/state/skilify` while exercising state code paths.
 *
 * Before this routing was wired, every `readState` / `writeState` /
 * `withRmwLock` / `tryAcquireWorkerLock` call inside a test would
 * stat-and-potentially-rename the real `~/.deeplake/state/skilify` despite
 * the env override on `state.ts`, because this helper hardcoded
 * `homedir()`. Test pollution leaked through that channel and is what
 * accumulated the orphan lock directories the env override is meant to
 * prevent.
 *
 * Re-entrancy: the "already attempted" set is keyed by resolved target
 * dir so a test that runs back-to-back with different `HIVEMIND_STATE_DIR`
 * values doesn't silently skip the migration in the second run.
 *
 * Error policy: only swallow the documented fallback codes — `EXDEV`
 * (cross-device link, e.g. `~/.deeplake` on a different mount than `/tmp`)
 * and `EPERM` (sandboxed or read-only home). In those cases we leave the
 * legacy dir in place and the new dir starts fresh — `pull` will repopulate
 * `pulled.json` but pre-rename installs may need manual cleanup. Every
 * other failure (`EIO`, `ENOSPC`, anything else) re-throws so the caller
 * sees the I/O error instead of silently losing user state.
 */

import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { log as _log } from "../utils/debug.js";
import { getStateDir } from "./state-dir.js";

const dlog = (msg: string) => _log("skillify-migrate", msg);

const attemptedFor = new Set<string>();

export function migrateLegacyStateDir(): void {
  const current = getStateDir();
  if (attemptedFor.has(current)) return;
  attemptedFor.add(current);
  const legacy = join(dirname(current), "skilify");
  if (!existsSync(legacy)) return;
  if (existsSync(current)) return;
  try {
    renameSync(legacy, current);
    dlog(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM") {
      dlog(`migration failed (${code}); leaving legacy dir in place`);
      return;
    }
    throw err;
  }
}
