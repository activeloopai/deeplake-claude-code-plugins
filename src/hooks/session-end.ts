#!/usr/bin/env node

/**
 * SessionEnd hook — flushes any queued session rows, then spawns the summary worker.
 *
 * The queue flush is synchronous so the worker sees the latest turn.
 * All heavy summary work happens in the detached wiki-worker process.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { log as _log } from "../utils/debug.js";
import { isDirectRun } from "../utils/direct-run.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { flushSessionQueue } from "./session-queue.js";

const log = (msg: string) => _log("session-end", msg);

export interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

interface SessionEndDeps {
  wikiWorker?: boolean;
  captureEnabled?: boolean;
  config?: Config | null;
  createApi?: (config: Config) => DeeplakeApi;
  flushSessionQueueFn?: typeof flushSessionQueue;
  spawnWikiWorkerFn?: typeof spawnWikiWorker;
  wikiLogFn?: typeof wikiLog;
  bundleDir?: string;
  logFn?: (msg: string) => void;
}

export async function runSessionEndHook(input: StopInput, deps: SessionEndDeps = {}): Promise<{
  status: "skipped" | "no_config" | "flushed";
  flushStatus?: string;
}> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    captureEnabled = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false",
    config = loadConfig(),
    createApi = (activeConfig) => new DeeplakeApi(
      activeConfig.token,
      activeConfig.apiUrl,
      activeConfig.orgId,
      activeConfig.workspaceId,
      activeConfig.sessionsTableName,
    ),
    flushSessionQueueFn = flushSessionQueue,
    spawnWikiWorkerFn = spawnWikiWorker,
    wikiLogFn = wikiLog,
    bundleDir = bundleDirFromImportMeta(import.meta.url),
    logFn = log,
  } = deps;

  if (wikiWorker || !captureEnabled || !input.session_id) return { status: "skipped" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }

  const flush = await flushSessionQueueFn(createApi(config), {
    sessionId: input.session_id,
    sessionsTable: config.sessionsTableName,
    waitIfBusyMs: 5000,
    drainAll: true,
  });
  logFn(`flush ${flush.status}: rows=${flush.rows} batches=${flush.batches}`);

  wikiLogFn(`SessionEnd: triggering summary for ${input.session_id}`);
  spawnWikiWorkerFn({
    config,
    sessionId: input.session_id,
    cwd: input.cwd ?? "",
    bundleDir,
    reason: "SessionEnd",
  });

  return { status: "flushed", flushStatus: flush.status };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  await runSessionEndHook(input);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
