#!/usr/bin/env node

/**
 * SessionEnd hook — spawns a background worker that builds the session summary.
 *
 * The hook writes a config file and spawns the bundled wiki-worker.js process.
 * It exits immediately — no API calls, no timeout risk.
 * All heavy work (fetching events, running claude -p, uploading) happens in the worker.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { log as _log } from "../utils/debug.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";

const log = (msg: string) => _log("session-end", msg);

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;
  if (process.env.DEEPLAKE_CAPTURE === "false") return;

  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  wikiLog(`SessionEnd: triggering summary for ${sessionId}`);
  spawnWikiWorker({
    config,
    sessionId,
    cwd,
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    reason: "SessionEnd",
  });
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
