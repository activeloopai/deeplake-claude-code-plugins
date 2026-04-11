import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.DEEPLAKE_DEBUG === "1";
const LOG = join(homedir(), ".deeplake", "hook-debug.log");

/** Format a Date (default: now) as `YYYY-MM-DD HH:MM:SS UTC`. */
export function utcTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function log(tag: string, msg: string) {
  if (!DEBUG) return;
  appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`);
}
