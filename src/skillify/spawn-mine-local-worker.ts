/**
 * Auto-trigger `hivemind skillify mine-local` from a SessionStart hook on
 * fresh installs where the user hasn't signed in yet. Detached background
 * spawn — the hook returns immediately; the next SessionStart fire sees
 * the manifest and surfaces the "N skills mined, sign in to share"
 * message produced by countLocalManifestEntries().
 *
 * Design constraints (in order of importance):
 *   1. Never block the SessionStart hook. Detached spawn, no wait.
 *   2. Never run more than once per user. Skip when manifest exists.
 *   3. Never compete with a running auto-mine. Skip when lock exists.
 *   4. Never run when there's nothing to mine. Skip when ~/.claude/projects/
 *      doesn't exist (truly-fresh Claude Code install).
 *   5. Never run when the user is already signed in. Auth users get the
 *      normal Stop-hook-driven mining flow.
 *
 * The lock is a sentinel only; it does NOT enforce a race-free
 * "exactly one worker at a time" invariant. Two SessionStart fires
 * inside a few milliseconds could both pass the check, both spawn,
 * both produce skills. mine-local's manifest sentinel makes that
 * benign (second worker exits early once the first writes the
 * manifest); the lock is cheaper than tightening fs primitives.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_MANIFEST_PATH, LOCAL_MINE_LOCK_PATH } from "./local-manifest.js";

const HOME = homedir();
const HIVEMIND_DIR = join(HOME, ".claude", "hivemind");
const LOG_PATH = join(HOME, ".claude", "hooks", "mine-local.log");
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");

// A run that hasn't produced a manifest after this window is presumed
// crashed; the lock can be overridden so future SessionStart fires can
// retry. mine-local's typical wall-clock is 60-120 s; 15 min gives a
// generous buffer for slow gates without leaving a stale lock forever.
const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * How to invoke the `hivemind` CLI. Two flavours:
 *   - `node-script`: run `node <path>` (path is a bundled cli.js inside the
 *     same plugin install as this hook). Preferred — guarantees the worker
 *     is the SAME version as the hook that spawned it, so a new subcommand
 *     introduced in this release can't go missing because the user has an
 *     older `hivemind` first on PATH.
 *   - `bin`: run the binary directly (resolved via `which hivemind`).
 *     Fallback for installs where the bundled cli.js is missing (e.g. a
 *     legacy install layout or a user who hand-trimmed the plugin tree).
 */
type HivemindLauncher =
  | { kind: "node-script"; path: string }
  | { kind: "bin"; path: string };

/**
 * Locate the CLI bundle that ships in the SAME plugin install as this
 * hook bundle. Layout:
 *   <plugin>/<agent>/bundle/session-start.js   ← spawn-mine-local-worker is bundled into this
 *   <plugin>/bundle/cli.js                     ← target
 * From either the source TS (during tests) or the bundled JS (at runtime),
 * the relative path `../../bundle/cli.js` lands on the shared CLI bundle.
 * Returns null when the file is missing — caller falls back to `which`.
 */
function findBundledCliPath(): string | null {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(thisDir, "..", "..", "bundle", "cli.js");
    return existsSync(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}

function findHivemindLauncher(): HivemindLauncher | null {
  const bundled = findBundledCliPath();
  if (bundled) return { kind: "node-script", path: bundled };
  try {
    const out = execFileSync("which", ["hivemind"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const bin = out.trim();
    return bin ? { kind: "bin", path: bin } : null;
  } catch {
    return null;
  }
}

/**
 * True only if at least one .jsonl file exists somewhere under
 * ~/.claude/projects/. Walks one level (the encoded-cwd subdirs) and
 * peeks for any .jsonl filename — cheap, avoids a full recursive scan.
 */
function hasLocalClaudeSessions(): boolean {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return false;
  let subdirs: string[];
  try {
    subdirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return false;
  }
  for (const sub of subdirs) {
    let files: string[];
    try {
      files = readdirSync(join(CLAUDE_PROJECTS_DIR, sub));
    } catch {
      continue;
    }
    if (files.some(f => f.endsWith(".jsonl"))) return true;
  }
  return false;
}

export interface AutoMineGuardReport {
  triggered: boolean;
  /** Why the spawn was skipped. Useful for the SessionStart hook log. */
  reason?:
    | "manifest-exists"
    | "lock-exists"
    | "no-claude-sessions"
    | "no-hivemind-bin"
    | "lock-acquire-failed"
    | "spawn-failed";
}

/**
 * Spawn `hivemind skillify mine-local` in the background if and only if
 * every guard passes. The caller has already verified that no Deeplake
 * credentials are present (we only auto-mine for not-signed-in users).
 */
export function maybeAutoMineLocal(): AutoMineGuardReport {
  if (existsSync(LOCAL_MANIFEST_PATH)) return { triggered: false, reason: "manifest-exists" };
  if (existsSync(LOCAL_MINE_LOCK_PATH)) {
    // If a prior auto-mine crashed before unlinking the lock, override it
    // after LOCK_STALE_MS has elapsed. The user shouldn't have to manually
    // remove the file to recover from a one-off failure.
    let stale = false;
    try {
      const stats = statSync(LOCAL_MINE_LOCK_PATH);
      stale = Date.now() - stats.mtimeMs > LOCK_STALE_MS;
    } catch { /* treat as not-stale */ }
    if (!stale) return { triggered: false, reason: "lock-exists" };
    try { unlinkSync(LOCAL_MINE_LOCK_PATH); }
    catch { return { triggered: false, reason: "lock-exists" }; }
  }
  if (!hasLocalClaudeSessions()) return { triggered: false, reason: "no-claude-sessions" };
  const launcher = findHivemindLauncher();
  if (!launcher) return { triggered: false, reason: "no-hivemind-bin" };

  // Acquire the lock as a courtesy sentinel against rapid double-fire.
  // The exclusive open (wx) is atomic on POSIX — only one caller can win.
  try {
    mkdirSync(HIVEMIND_DIR, { recursive: true });
    const fd = openSync(LOCAL_MINE_LOCK_PATH, "wx");
    closeSync(fd);
  } catch {
    return { triggered: false, reason: "lock-acquire-failed" };
  }

  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    const out = openSync(LOG_PATH, "a");
    const [cmd, args] = launcher.kind === "node-script"
      ? [process.execPath, [launcher.path, "skillify", "mine-local"]]
      : [launcher.path, ["skillify", "mine-local"]];
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    closeSync(out);
    child.unref();
    return { triggered: true };
  } catch {
    try { unlinkSync(LOCAL_MINE_LOCK_PATH); } catch { /* best-effort */ }
    return { triggered: false, reason: "spawn-failed" };
  }
}
