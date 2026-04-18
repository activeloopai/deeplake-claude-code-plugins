#!/usr/bin/env node

/**
 * Capture hook — appends session events to a local queue on the hot path.
 * Stop/SubagentStop flush that queue to the sessions table in batched INSERTs.
 *
 * Used by: UserPromptSubmit, PostToolUse (async), Stop, SubagentStop
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { log as _log } from "../utils/debug.js";
import {
  bumpTotalCount,
  loadTriggerConfig,
  shouldTrigger,
  tryAcquireLock,
} from "./summary-state.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import {
  appendQueuedSessionRow,
  buildQueuedSessionRow,
  buildSessionPath,
  flushSessionQueue,
} from "./session-queue.js";

const log = (msg: string) => _log("capture", msg);

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  // Stop / SubagentStop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  agent_transcript_path?: string;
}

const CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<HookInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  // Build the event entry
  const ts = new Date().toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp: ts,
  };

  let entry: Record<string, unknown>;

  if (input.prompt !== undefined) {
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  } else if (input.tool_name !== undefined) {
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
  } else if (input.last_assistant_message !== undefined) {
    log(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...(input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}),
    };
  } else {
    log("unknown event, skipping");
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
    agent: "claude_code",
    timestamp: ts,
  }));
  log(`queued ${input.hook_event_name ?? "event"} for ${sessionPath}`);

  maybeTriggerPeriodicSummary(input.session_id, input.cwd ?? "", config);

  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    const api = new DeeplakeApi(
      config.token,
      config.apiUrl,
      config.orgId,
      config.workspaceId,
      config.sessionsTableName,
    );
    const result = await flushSessionQueue(api, {
      sessionId: input.session_id,
      sessionsTable: config.sessionsTableName,
      drainAll: true,
    });
    log(`flush ${result.status}: rows=${result.rows} batches=${result.batches}`);
  }
}

/** Increment the event counter and, if the threshold is crossed, spawn a background wiki worker. */
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
    spawnWikiWorker({
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
