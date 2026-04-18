#!/usr/bin/env node

/**
 * Codex Capture hook — appends session events to a local queue on the hot path.
 *
 * Used by: UserPromptSubmit, PostToolUse
 *
 * Codex input fields:
 *   All events: session_id, transcript_path, cwd, hook_event_name, model
 *   UserPromptSubmit: prompt (user text)
 *   PostToolUse: tool_name, tool_use_id, tool_input, tool_response
 *   Stop: (no extra fields — Codex has no last_assistant_message equivalent)
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig, type Config } from "../../config.js";
import { log as _log } from "../../utils/debug.js";
import {
  bumpTotalCount,
  loadTriggerConfig,
  shouldTrigger,
  tryAcquireLock,
} from "../summary-state.js";
import { bundleDirFromImportMeta, spawnCodexWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import {
  appendQueuedSessionRow,
  buildQueuedSessionRow,
  buildSessionPath,
} from "../session-queue.js";

const log = (msg: string) => _log("codex-capture", msg);

interface CodexHookInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse (Bash only in Codex)
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
  tool_response?: Record<string, unknown>;
}

const CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<CodexHookInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const ts = new Date().toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    model: input.model,
    turn_id: input.turn_id,
    timestamp: ts,
  };

  let entry: Record<string, unknown>;

  if (input.hook_event_name === "UserPromptSubmit" && input.prompt !== undefined) {
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  } else if (input.hook_event_name === "PostToolUse" && input.tool_name !== undefined) {
    log(`tool=${input.tool_name} session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response),
    };
  } else {
    log(`unknown event: ${input.hook_event_name}, skipping`);
    return;
  }

  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRow(buildQueuedSessionRow({
    sessionPath,
    line,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "codex",
    timestamp: ts,
  }));
  log(`queued ${input.hook_event_name} for ${sessionPath}`);

  maybeTriggerPeriodicSummary(input.session_id, input.cwd ?? "", config);
}

function maybeTriggerPeriodicSummary(sessionId: string, cwd: string, config: Config): void {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  try {
    const state = bumpTotalCount(sessionId);
    const cfg = loadTriggerConfig();
    if (!shouldTrigger(state, cfg)) return;

    if (!tryAcquireLock(sessionId)) {
      log(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }

    wikiLog(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    spawnCodexWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Periodic",
    });
  } catch (e: any) {
    log(`periodic trigger error: ${e.message}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
