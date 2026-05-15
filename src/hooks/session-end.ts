#!/usr/bin/env node

/**
 * SessionEnd hook — spawns a background worker that builds the session summary.
 *
 * The hook writes a config file and spawns the bundled wiki-worker.js process.
 * It exits immediately — no API calls, no timeout risk.
 * All heavy work (fetching events, running claude -p, uploading) happens in the worker.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig, type Config } from "../config.js";
import { log as _log } from "../utils/debug.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { tryAcquireLock, releaseLock } from "./summary-state.js";
import { forceSessionEndTrigger } from "../skillify/triggers.js";
import { parseTranscript } from "../notifications/transcript-parser.js";
import { appendUsageRecord } from "../notifications/usage-tracker.js";

const log = (msg: string) => _log("session-end", msg);

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

/**
 * Parse the session transcript for memory-search activity and append one
 * record to `~/.deeplake/usage-stats.jsonl`. Fail-soft on every step.
 *
 * Runs independent of the wiki-worker lock — even sessions where the
 * wiki worker can't run still contribute to the savings recap (the recap
 * only needs memory-grep activity, not summaries).
 */
function recordSessionUsage(transcriptPath: string | undefined, sessionId: string): void {
  if (!transcriptPath) return;
  try {
    const record = parseTranscript(transcriptPath, sessionId);
    if (record.memorySearchCount === 0 && record.memorySearchBytes === 0) {
      log(`no memory searches in session ${sessionId} — skipping usage record`);
      return;
    }
    appendUsageRecord(record);
  } catch (e: any) {
    log(`recordSessionUsage failed: ${e?.message ?? String(e)}`);
  }
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  if (process.env.HIVEMIND_CAPTURE === "false") return;

  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  // Record memory-search activity for the savings recap. Independent of the
  // wiki-worker lock below: even sessions where the wiki worker can't run
  // should still contribute to the recap (only need memory-grep counts,
  // not summaries).
  recordSessionUsage(input.transcript_path, sessionId);

  // Coordinate with the periodic worker: if one is already running for this
  // session, skip. Two workers writing the same summary row trip the
  // Deeplake UPDATE-coalescing quirk (see CLAUDE.md) and drop one write.
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`SessionEnd: periodic worker already running for ${sessionId}, skipping`);
    return;
  }

  wikiLog(`SessionEnd: triggering summary for ${sessionId}`);
  try {
    spawnWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "SessionEnd",
    });
  } catch (e: any) {
    // Spawn threw before the worker took ownership of the lock: release
    // it here so a --resume can retrigger periodic summaries without
    // waiting for the 10-minute stale reclaim.
    log(`spawn failed: ${e.message}`);
    try {
      releaseLock(sessionId);
    } catch (releaseErr: any) {
      log(`releaseLock after spawn failure also failed: ${releaseErr.message}`);
    }
    throw e;
  }

  forceSessionEndTrigger({
    config,
    cwd,
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    agent: "claude_code",
    sessionId,
  });
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
