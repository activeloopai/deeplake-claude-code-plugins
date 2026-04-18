#!/usr/bin/env node

/**
 * SessionEnd hook — flushes any queued session rows, then spawns the summary worker.
 *
 * The queue flush is synchronous so the worker sees the latest turn.
 * All heavy summary work (fetching events, running claude -p, uploading) happens
 * in the detached wiki-worker process.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { log as _log } from "../utils/debug.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { flushSessionQueue } from "./session-queue.js";

const log = (msg: string) => _log("session-end", msg);

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  if ((process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1") return;
  if ((process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) === "false") return;

  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.sessionsTableName,
  );
  const flush = await flushSessionQueue(api, {
    sessionId,
    sessionsTable: config.sessionsTableName,
    waitIfBusyMs: 5000,
    drainAll: true,
  });
  log(`flush ${flush.status}: rows=${flush.rows} batches=${flush.batches}`);

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
