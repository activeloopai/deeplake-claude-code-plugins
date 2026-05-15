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
 * Error policy: only swallow the documented fallback codes — `EXDEV`
 * (cross-device link, e.g. `~/.deeplake` on a different mount than `/tmp`)
 * and `EPERM` (sandboxed or read-only home). In those cases we leave the
 * legacy dir in place and the new dir starts fresh — `pull` will repopulate
 * `pulled.json` but pre-rename installs may need manual cleanup. Every
 * other failure (`EIO`, `ENOSPC`, anything else) re-throws so the caller
 * sees the I/O error instead of silently losing user state.
 */

import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log as _log } from "../utils/debug.js";

const dlog = (msg: string) => _log("skillify-migrate", msg);

let attempted = false;

export function migrateLegacyStateDir(): void {
  if (attempted) return;
  attempted = true;
  const root = join(homedir(), ".deeplake", "state");
  const legacy = join(root, "skilify");
  const current = join(root, "skillify");
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
