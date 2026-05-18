import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG = join(homedir(), ".deeplake", "hook-debug.log");

// Lazy read: the openclaw bundle replaces `process.env.HIVEMIND_DEBUG`
// with `globalThis.__hivemind_tuning__.HIVEMIND_DEBUG` via esbuild
// `define`. The lookup must happen at call-time (not module-init) so it
// picks up the values openclaw populates AFTER this module is imported.
// Was previously `const DEBUG = …` at module top — that would have frozen
// the value to `false` for the openclaw bundle regardless of pluginConfig.
function isDebug(): boolean {
  return process.env.HIVEMIND_DEBUG === "1";
}

/** Format a Date (default: now) as `YYYY-MM-DD HH:MM:SS UTC`. */
export function utcTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function log(tag: string, msg: string) {
  if (!isDebug()) return;
  appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`);
}
