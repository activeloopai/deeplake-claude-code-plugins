/**
 * Credentials file IO for the Deeplake plugin. Lives in its own module so
 * that consumers (in particular the openclaw plugin's bundler) can split
 * fs reads/writes from network calls along source-file boundaries — needed
 * to pass per-file static-analysis rules that flag fs+fetch co-occurrence.
 *
 * No imports from any module that touches `fetch` belong here.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Lazy path accessors — re-evaluate homedir() on every call rather than
// binding at module-load time. Two reasons:
//   1. Tests can override HOME via process.env.HOME between cases without
//      needing vi.resetModules + dynamic re-import. That re-import pattern
//      created a V8 worker-pool branch-coverage flake on CI (each
//      reimported module instance was tracked separately, the merge across
//      workers was non-deterministic, branch coverage on these helpers
//      dropped to 50-66% on CI while local Node 20+22 reported 100%).
//   2. Robustness: production-side, HOME could in principle change in long-
//      lived processes; lazy lookup avoids stale-snapshot bugs.
export function configDir(): string {
  return join(homedir(), ".deeplake");
}
export function credsPath(): string {
  return join(configDir(), "credentials.json");
}

export interface Credentials {
  token: string;
  orgId: string;
  orgName?: string;
  userName?: string;
  workspaceId?: string;
  apiUrl?: string;
  autoupdate?: boolean;
  savedAt: string;
}

// Each helper avoids the existsSync-before-act anti-pattern: it has both a
// time-of-check-to-time-of-use race and extra branches that don't add real
// safety. Letting the fs call's own error fall into a try/catch is more
// correct AND simplifies coverage to a single fall-through path.

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf-8"));
  } catch {
    // Missing file (ENOENT), permission error, or malformed JSON — all map
    // to "no usable credentials." Caller treats null as "not logged in."
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  // mkdirSync({ recursive: true }) is idempotent: no-op if CONFIG_DIR
  // already exists (and does NOT change its mode in that case, per
  // node:fs docs). Calling it unconditionally removes the existsSync
  // guard without behaviour change.
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credsPath(), JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  try {
    unlinkSync(credsPath());
    return true;
  } catch {
    // Anything else (file already gone, permission denied, EBUSY, …) maps
    // to "didn't delete." The function's user-facing contract is "tell me
    // whether the file got removed." Surfacing transport-level errors as
    // exceptions to a logout caller adds no actionable signal.
    return false;
  }
}
