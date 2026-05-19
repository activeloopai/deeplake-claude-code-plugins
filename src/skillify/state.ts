/**
 * Per-project state for the skillify worker.
 *
 * File: ~/.deeplake/state/skillify/<projectKey>.json
 *   {
 *     project: string,           // human-readable project name
 *     projectKey: string,        // stable id derived from git remote or cwd hash
 *     counter: number,           // Stop events since last worker fire
 *     lastUuid: string | null,   // most recent session uuid mined
 *     lastDate: string | null,   // ISO timestamp of most recent session mined
 *     skillsGenerated: string[], // skill names this worker has produced
 *     updatedAt: number,         // epoch ms
 *   }
 *
 * Survives across sessions; never deleted. All mutations go through
 * withRmwLock so concurrent processes don't lose updates.
 */

import {
  readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, rmdirSync,
  existsSync, lstatSync, unlinkSync, openSync, closeSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { log as _log } from "../utils/debug.js";
import { migrateLegacyStateDir } from "./legacy-migration.js";
import { getStateDir } from "./state-dir.js";

export { getStateDir };

const dlog = (msg: string) => _log("skillify-state", msg);

export interface SkillifyState {
  project: string;
  projectKey: string;
  counter: number;
  lastUuid: string | null;
  lastDate: string | null;
  skillsGenerated: string[];
  updatedAt: number;
}

const YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));

export const TRIGGER_THRESHOLD = (() => {
  const n = Number(process.env.HIVEMIND_SKILLIFY_EVERY_N_TURNS ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
})();

export function statePath(projectKey: string): string {
  return join(getStateDir(), `${projectKey}.json`);
}

function lockPath(projectKey: string): string {
  return join(getStateDir(), `${projectKey}.lock`);
}

/**
 * Collapse the many surface forms of a git remote URL down to a canonical
 * string so different clone styles of the SAME repo produce the same hash.
 *
 * Without this, sha1 raw input gives 5 different keys for the same repo:
 *   git@github.com:org/repo.git
 *   git@github.com:org/repo
 *   https://github.com/org/repo.git
 *   https://github.com/org/repo
 *   https://user@github.com/org/repo.git
 *
 * All collapse to `github.com/org/repo`. Returns the input unchanged when
 * it doesn't look like a git URL (so the cwd-fallback path keeps absolute
 * disk paths distinct).
 */
/**
 * Default port per scheme. If the URL carries `:<defaultPort>` explicitly,
 * we strip it so `https://host:443/x` collapses with `https://host/x`
 * (otherwise the two hash to different project keys despite being the same
 * remote). Non-default ports (e.g. `:8443`) are preserved — they're
 * load-bearing.
 */
const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418",
};

export function normalizeGitRemoteUrl(url: string): string {
  let s = url.trim();
  // 1. Capture + strip URL scheme (https://, http://, git://, ssh://, …).
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  if (schemeMatch) s = s.slice(schemeMatch[0].length);
  // 2. SCP-style remote (no scheme prefix): `[user@]host:path` → `host/path`.
  //    Only applies when the original input had no scheme — otherwise the
  //    `:` is from `host:port`, not the SCP separator.
  if (!scheme) {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) s = `${scp[1]}/${scp[2]}`;
  }
  // 3. Strip embedded credentials (user@ or user:pass@) from the host part.
  s = s.replace(/^[^@/]+@/, "");
  // 4. Strip the default port for the scheme (e.g. `:443` on https) — it
  //    is implied and shouldn't make the hash diverge from the port-less
  //    form. Non-default ports stay (e.g. `:8443`).
  if (scheme && DEFAULT_PORTS[scheme]) {
    s = s.replace(new RegExp(`^([^/]+):${DEFAULT_PORTS[scheme]}(/|$)`), "$1$2");
  }
  // 5. Drop trailing `.git` (with or without trailing slash) and any
  //    remaining trailing slash.
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/** Stable project identifier — git remote URL hash, fallback to cwd basename hash. */
export function deriveProjectKey(cwd: string): { key: string; project: string } {
  const project = basename(cwd) || "unknown";
  let signature: string | null = null;
  try {
    const raw = execSync("git config --get remote.origin.url", {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    signature = raw ? normalizeGitRemoteUrl(raw) : null;
  } catch {
    // not a git repo, or no origin
  }
  // Hash whichever signature we have; falls back to absolute cwd so two
  // different checkouts with no remote still get distinct keys.
  const input = signature ?? cwd;
  const key = createHash("sha1").update(input).digest("hex").slice(0, 16);
  return { key, project };
}

export function readState(projectKey: string): SkillifyState | null {
  // Workers call readState() first to find the session watermark. Without
  // migration here, a post-rename run sees an empty `skillify/` dir while
  // the data still lives at `skilify/<key>.json` — and the worker would
  // re-mine sessions it has already processed.
  migrateLegacyStateDir();
  const p = statePath(projectKey);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SkillifyState;
  } catch {
    return null;
  }
}

export function writeState(projectKey: string, state: SkillifyState): void {
  migrateLegacyStateDir();
  mkdirSync(getStateDir(), { recursive: true });
  const p = statePath(projectKey);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

export function withRmwLock<T>(projectKey: string, fn: () => T): T {
  migrateLegacyStateDir();
  mkdirSync(getStateDir(), { recursive: true });
  const rmw = lockPath(projectKey) + ".rmw";
  const deadline = Date.now() + 2000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(rmw, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        dlog(`rmw lock deadline exceeded for ${projectKey}, reclaiming stale lock`);
        try { unlinkSync(rmw); } catch (unlinkErr: any) {
          dlog(`stale rmw lock unlink failed for ${projectKey}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try { return fn(); }
  finally {
    closeSync(fd);
    try { unlinkSync(rmw); } catch (unlinkErr: any) {
      dlog(`rmw lock cleanup failed for ${projectKey}: ${unlinkErr.message}`);
    }
  }
}

/**
 * Increment the Stop counter for a project. Initializes state on first call.
 * Returns the resulting state.
 */
export function bumpStopCounter(cwd: string): SkillifyState {
  const { key, project } = deriveProjectKey(cwd);
  return withRmwLock(key, () => {
    const existing = readState(key);
    const next: SkillifyState = existing
      ? { ...existing, counter: existing.counter + 1, updatedAt: Date.now() }
      : {
          project,
          projectKey: key,
          counter: 1,
          lastUuid: null,
          lastDate: null,
          skillsGenerated: [],
          updatedAt: Date.now(),
        };
    writeState(key, next);
    return next;
  });
}

/** Reset the counter after a worker fire. */
export function resetCounter(projectKey: string): void {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s) return;
    writeState(projectKey, { ...s, counter: 0, updatedAt: Date.now() });
  });
}

/** Record that a worker produced a skill (KEEP or MERGE). */
export function recordSkill(
  projectKey: string,
  skillName: string,
  newestSessionUuid: string,
  newestSessionDate: string,
): void {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s) return;
    const skills = s.skillsGenerated.includes(skillName)
      ? s.skillsGenerated
      : [...s.skillsGenerated, skillName];
    writeState(projectKey, {
      ...s,
      skillsGenerated: skills,
      lastUuid: newestSessionUuid,
      lastDate: newestSessionDate,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Advance the watermark even when no skill was created (SKIP verdict).
 * Stops the worker from re-mining the same range next time.
 */
export function advanceWatermark(
  projectKey: string,
  newestSessionUuid: string,
  newestSessionDate: string,
): void {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s) return;
    writeState(projectKey, {
      ...s,
      lastUuid: newestSessionUuid,
      lastDate: newestSessionDate,
      updatedAt: Date.now(),
    });
  });
}

/** Cross-project lock so a single worker fires at a time per project. */
export function tryAcquireWorkerLock(projectKey: string, maxAgeMs = 10 * 60 * 1000): boolean {
  migrateLegacyStateDir();
  mkdirSync(getStateDir(), { recursive: true });
  const p = lockPath(projectKey);
  if (existsSync(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs) return false;
    } catch (readErr: any) {
      dlog(`worker lock unreadable for ${projectKey}, treating as stale: ${readErr.message}`);
    }
    try { unlinkSync(p); } catch (unlinkErr: any) {
      // Self-heal for stale lock-as-directory: an interrupted run of
      // tests/claude-code/skillify-state.test.ts ("treats an unreadable
      // lock file as stale") used to leave `<key>.lock` as an empty
      // directory when its `rmdirSync` cleanup was killed before
      // firing. Once that happens, every subsequent `unlinkSync` fails
      // (POSIX: EISDIR, Windows: EPERM) and the project's Stop-counter
      // trigger silently no-ops forever.
      //
      // TOCTOU defense: we use `rmdirSync(p)` for the recovery instead
      // of `rmSync(p, { recursive: true, force: true })`. A concurrent
      // process may have already cleared the stale dir and
      // `openSync(p, "wx")`-ed a fresh lock file in the same path
      // while we sat between the failed `unlinkSync` and the recovery.
      // `rmSync` with `force/recursive` would happily unlink that
      // racing process's live lock, letting both processes' subsequent
      // `openSync(wx)` succeed and double-acquire the worker slot.
      // `rmdirSync` is shape-aware:
      //   - regular file at the path → ENOTDIR (POSIX) / ENOENT (Win)
      //   - non-empty directory      → ENOTEMPTY
      //   - path gone                → ENOENT
      //   - empty directory          → removes it (the actual recovery)
      // Every error case is safe to ignore — the final `openSync(p,
      // "wx")` arbitrates atomically: exactly one process wins.
      //
      // We accept EISDIR (POSIX unlink-on-directory), EPERM (Windows
      // surfaces this for the same operation), and ENOENT (a racing
      // process already cleaned the stale path between our `existsSync`
      // check and the `unlinkSync` call — perfect, the atomic
      // `openSync(p, "wx")` below will win or lose as appropriate).
      // `lstat` errors are NOT terminal either: a missing file means
      // the race already cleared the path; a permission error means
      // we can't tell, so we let `openSync` arbitrate instead of
      // returning false eagerly.
      if (unlinkErr?.code !== "EISDIR"
          && unlinkErr?.code !== "EPERM"
          && unlinkErr?.code !== "ENOENT") {
        dlog(`could not unlink stale worker lock for ${projectKey}: ${unlinkErr.message}`);
        return false;
      }
      let isDir = false;
      try { isDir = lstatSync(p).isDirectory(); } catch { /* stat unavailable — let openSync arbitrate */ }
      if (isDir) {
        try { rmdirSync(p); } catch (rmErr: any) {
          // ENOTDIR / ENOTEMPTY / ENOENT / EACCES — all safe to ignore.
          // openSync(p, "wx") below is the atomic arbiter.
          dlog(`rmdir stale lock skipped for ${projectKey}: ${rmErr.message}`);
        }
      }
    }
  }
  try {
    const fd = openSync(p, "wx");
    try { writeSync(fd, String(Date.now())); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

export function releaseWorkerLock(projectKey: string): void {
  const p = lockPath(projectKey);
  try { unlinkSync(p); } catch { /* may already be gone */ }
}
