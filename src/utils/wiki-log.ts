/**
 * wikiLog writer factory. Produces a unconditional append-line logger
 * that targets a user-visible wiki-log file. Each plugin variant has
 * its own path (CC: ~/.claude/hooks/..., Codex: ~/.codex/hooks/...),
 * so the caller constructs the logger once by passing HOOKS_DIR.
 *
 * This is the *user-visible* log — entries like "SessionEnd:
 * triggering summary for <sid>" land here regardless of HIVEMIND_DEBUG.
 * For debug-gated diagnostics use `_log` from src/utils/debug.ts.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { utcTimestamp } from "./debug.js";

export interface WikiLogger {
  log: (msg: string) => void;
  path: string;
}

export function makeWikiLogger(hooksDir: string, filename = "deeplake-wiki.log"): WikiLogger {
  const path = join(hooksDir, filename);
  return {
    path,
    log(msg: string): void {
      try {
        mkdirSync(hooksDir, { recursive: true });
        appendFileSync(path, `[${utcTimestamp()}] ${msg}\n`);
      } catch { /* ignore — a log failure must never crash the hook */ }
    },
  };
}
