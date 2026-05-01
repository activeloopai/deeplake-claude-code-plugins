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

export const CONFIG_DIR = join(homedir(), ".deeplake");
export const CREDS_PATH = join(CONFIG_DIR, "credentials.json");

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
// time-of-check-to-time-of-use race and an extra branch that v8 coverage
// instrumentation handled inconsistently across vitest workers (see the
// matching note in claude-code/tests/auth-creds.test.ts). Letting the fs
// call's own error fall into a try/catch is more correct AND removes the
// flaky branch.

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
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
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  try {
    unlinkSync(CREDS_PATH);
    return true;
  } catch (err) {
    // Only "file already gone" is an expected miss → return false. Genuine
    // errors (permission denied, EBUSY, …) propagate so the caller can
    // surface them — matches the pre-refactor behaviour where unlinkSync's
    // non-ENOENT errors threw out of the function.
    //
    // Direct property access (no optional chaining): err from a thrown fs
    // call is guaranteed to be an Error subclass with .code present, and
    // CI's V8 build was instrumenting the optional chain as a separate
    // branch whose nullish-err path is never exercised — dropping `?.`
    // collapses two coverage branches to one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
