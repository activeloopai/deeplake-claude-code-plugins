/**
 * Single source of truth for the on-disk skillify state directory.
 *
 * Extracted out of `state.ts` so siblings that also live under
 * `~/.deeplake/state/skillify/` (lock state, scope config, pulled
 * manifest, legacy migration) can route through one resolver without
 * pulling in `state.ts`'s heavier dependency graph or creating an
 * ESM cycle with `legacy-migration.ts`.
 *
 * The path is computed lazily on every call so tests (and any other
 * caller that swaps `process.env.HOME` or `HIVEMIND_STATE_DIR` between
 * operations) actually affect the path. A module-level `const` would
 * capture the developer's real home at import time and bypass any
 * isolation, which is exactly what accumulated 80+ orphaned
 * `<key>.lock` directories on dev machines — every
 * `skillify-state.test.ts` run that the cleanup `rmdirSync` couldn't
 * reach left one behind in the real `~/.deeplake/state/skillify/`.
 *
 * `HIVEMIND_STATE_DIR` is honoured first so tests can point the whole
 * subsystem at a `mkdtempSync()` directory without monkey-patching
 * `os.homedir`. Falls back to `~/.deeplake/state/skillify`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function getStateDir(): string {
  // Trim before truthy-check so `HIVEMIND_STATE_DIR=""` or
  // `HIVEMIND_STATE_DIR="   "` (forgotten value in CI config, accidental
  // empty pass-through) does NOT win the `??` arm. An empty string is
  // a perfectly valid env value — `??` would accept it — but downstream
  // `join("", ".deeplake", ...)` resolves relative to the worker's cwd
  // and silently pollutes whatever directory the process was started in.
  // Treat blank as unset.
  const override = process.env.HIVEMIND_STATE_DIR?.trim();
  return override && override.length > 0
    ? override
    : join(homedir(), ".deeplake", "state", "skillify");
}
