#!/usr/bin/env node

/**
 * Cursor sessionEnd hook (fire-and-forget).
 *
 * Cursor input: { session_id, reason, duration_ms, is_background_agent,
 *                 final_status, error_message? } + common payload.
 *
 * For now this is a stub that simply logs and exits 0; the wiki-summary
 * trigger lives in capture.ts (per-event threshold) for the other agents.
 * Future work: spawn a final wiki-worker run on sessionEnd similar to
 * Claude's session-end.ts.
 */

import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
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
  const sessionId = input.conversation_id ?? input.session_id ?? "?";
  log(`session=${sessionId} reason=${input.reason ?? "?"} status=${input.final_status ?? "?"}`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
