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
 * Error policy: swallow the documented fallback codes — `EXDEV`
 * (cross-device link, e.g. `~/.deeplake` on a different mount than `/tmp`),
 * `EPERM` (sandboxed or read-only home), and the multi-process race codes
 * `ENOENT` / `EEXIST` / `ENOTEMPTY` (another worker / hook / install
 * raced past the existsSync checks and either migrated the dir or
 * recreated the target between our stat and rename — both outcomes are
 * "migration handled" from our point of view, not a failure to surface).
 * Every other failure (`EIO`, `ENOSPC`, anything else) re-throws so the
 * caller sees the I/O error instead of silently losing user state.
 */

import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { log as _log } from "../utils/debug.js";
import { getStateDir } from "./state-dir.js";

const dlog = (msg: string) => _log("skillify-migrate", msg);

const attemptedFor = new Set<string>();

export function migrateLegacyStateDir(): void {
  // Hard guard: when `HIVEMIND_STATE_DIR` is set we are explicitly NOT
  // in the canonical home-based layout. The `skilify`-vs-`skillify`
  // typo migration is a one-shot upgrade against the historical
  // `~/.deeplake/state/` parent and has no meaning anywhere else.
  // Without this guard, an override like `HIVEMIND_STATE_DIR=/tmp/foo`
  // would still cause us to `existsSync('/tmp/skilify')` and — if some
  // unrelated tool happened to have created that directory —
  // `renameSync('/tmp/skilify', '/tmp/foo')` and move someone else's
  // content into our state path. Tests (and any other caller that
  // overrides) get a hard no-op here and a clean tmp-dir start.
  if (process.env.HIVEMIND_STATE_DIR?.trim()) return;

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
    // EXDEV/EPERM: documented fallback, migration not possible — leave
    // legacy dir for manual cleanup.
    // ENOENT/EEXIST/ENOTEMPTY: another process raced past our
    // existsSync checks and finished (or partially finished) the
    // migration between our stat and the renameSync. The work is
    // already done (or being done by the racer), so silently move on.
    if (code === "EXDEV" || code === "EPERM"
        || code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      dlog(`migration skipped (${code}); legacy dir left as-is or another process handled it`);
      return;
    }
    throw err;
  }
}
