#!/usr/bin/env node

/**
 * Cursor sessionEnd hook (fire-and-forget).
 *
 * Cursor input: { session_id, reason, duration_ms, is_background_agent,
 *                 final_status, error_message? } + common payload.
 *
 * Spawns a final wiki-worker run via cursor-agent --print so the session
 * gets an AI summary in the memory table. Mirrors the codex/CC flow.
 */

import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { loadConfig } from "../../config.js";
import { tryAcquireLock } from "../summary-state.js";
import { bundleDirFromImportMeta, spawnCursorWikiWorker, wikiLog } from "./spawn-wiki-worker.js";

const log = (msg: string) => _log("cursor-session-end", msg);

interface CursorSessionEndInput {
  conversation_id?: string;
  session_id?: string;
  reason?: string;
  duration_ms?: number;
  final_status?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  const input = await readStdin<CursorSessionEndInput>();
  const sessionId = input.conversation_id ?? input.session_id ?? "";
  log(`session=${sessionId || "?"} reason=${input.reason ?? "?"} status=${input.final_status ?? "?"}`);
  if (!sessionId) return;
  // Coordinate with the periodic worker: skip the final spawn if a periodic
  // is mid-flight. Lock TTL covers crashed workers.
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`SessionEnd: periodic worker already running for ${sessionId}, skipping final`);
    return;
  }
  try {
    const config = loadConfig();
    if (!config) { wikiLog(`SessionEnd: no config, skipping summary`); return; }
    spawnCursorWikiWorker({
      config,
      sessionId,
      cwd: process.cwd(),
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "SessionEnd",
    });
  } catch (e: any) {
    wikiLog(`SessionEnd: spawn failed: ${e?.message ?? e}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
