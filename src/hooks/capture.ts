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
import { isDirectRun } from "../utils/direct-run.js";
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
import { clearSessionQueryCache } from "./query-cache.js";

const log = (msg: string) => _log("capture", msg);

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  agent_transcript_path?: string;
}

const CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";

export function buildCaptureEntry(input: HookInput, timestamp: string): Record<string, unknown> | null {
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp,
  };

  if (input.prompt !== undefined) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  }

  if (input.tool_name !== undefined) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response),
    };
  }

  if (input.last_assistant_message !== undefined) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...(input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}),
    };
  }

  return null;
}

interface PeriodicSummaryDeps {
  bundleDir?: string;
  wikiWorker?: boolean;
  logFn?: (msg: string) => void;
  bumpTotalCountFn?: typeof bumpTotalCount;
  loadTriggerConfigFn?: typeof loadTriggerConfig;
  shouldTriggerFn?: typeof shouldTrigger;
  tryAcquireLockFn?: typeof tryAcquireLock;
  wikiLogFn?: typeof wikiLog;
  spawnWikiWorkerFn?: typeof spawnWikiWorker;
}

export function maybeTriggerPeriodicSummary(sessionId: string, cwd: string, config: Config, deps: PeriodicSummaryDeps = {}): void {
  const {
    bundleDir = bundleDirFromImportMeta(import.meta.url),
    wikiWorker = process.env.HIVEMIND_WIKI_WORKER === "1",
    logFn = log,
    bumpTotalCountFn = bumpTotalCount,
    loadTriggerConfigFn = loadTriggerConfig,
    shouldTriggerFn = shouldTrigger,
    tryAcquireLockFn = tryAcquireLock,
    wikiLogFn = wikiLog,
    spawnWikiWorkerFn = spawnWikiWorker,
  } = deps;

  if (wikiWorker) return;

  try {
    const state = bumpTotalCountFn(sessionId);
    const cfg = loadTriggerConfigFn();
    if (!shouldTriggerFn(state, cfg)) return;

    if (!tryAcquireLockFn(sessionId)) {
      logFn(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }

    wikiLogFn(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    spawnWikiWorkerFn({
      config,
      sessionId,
      cwd,
      bundleDir,
      reason: "Periodic",
    });
  } catch (e: any) {
    logFn(`periodic trigger error: ${e.message}`);
  }
}

interface CaptureHookDeps {
  captureEnabled?: boolean;
  config?: Config | null;
  now?: () => string;
  createApi?: (config: Config) => DeeplakeApi;
  appendQueuedSessionRowFn?: typeof appendQueuedSessionRow;
  buildQueuedSessionRowFn?: typeof buildQueuedSessionRow;
  flushSessionQueueFn?: typeof flushSessionQueue;
  clearSessionQueryCacheFn?: typeof clearSessionQueryCache;
  maybeTriggerPeriodicSummaryFn?: typeof maybeTriggerPeriodicSummary;
  logFn?: (msg: string) => void;
}

export async function runCaptureHook(input: HookInput, deps: CaptureHookDeps = {}): Promise<{
  status: "disabled" | "no_config" | "ignored" | "queued";
  entry?: Record<string, unknown>;
  flushStatus?: string;
}> {
  const {
    captureEnabled = CAPTURE,
    config = loadConfig(),
    now = () => new Date().toISOString(),
    createApi = (activeConfig) => new DeeplakeApi(
      activeConfig.token,
      activeConfig.apiUrl,
      activeConfig.orgId,
      activeConfig.workspaceId,
      activeConfig.sessionsTableName,
    ),
    appendQueuedSessionRowFn = appendQueuedSessionRow,
    buildQueuedSessionRowFn = buildQueuedSessionRow,
    flushSessionQueueFn = flushSessionQueue,
    clearSessionQueryCacheFn = clearSessionQueryCache,
    maybeTriggerPeriodicSummaryFn = maybeTriggerPeriodicSummary,
    logFn = log,
  } = deps;

  if (!captureEnabled) return { status: "disabled" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }

  const ts = now();
  const entry = buildCaptureEntry(input, ts);
  if (!entry) {
    logFn("unknown event, skipping");
    return { status: "ignored" };
  }

  if (input.prompt !== undefined) logFn(`user session=${input.session_id}`);
  else if (input.tool_name !== undefined) logFn(`tool=${input.tool_name} session=${input.session_id}`);
  else logFn(`assistant session=${input.session_id}`);

  if (input.hook_event_name === "UserPromptSubmit") {
    clearSessionQueryCacheFn(input.session_id);
  }

  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRowFn(buildQueuedSessionRowFn({
    sessionPath,
    line,
    sessionId: input.session_id,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "claude_code",
    timestamp: ts,
  }));
  logFn(`queued ${input.hook_event_name ?? "event"} for ${sessionPath}`);

  maybeTriggerPeriodicSummaryFn(input.session_id, input.cwd ?? "", config);

  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    const result = await flushSessionQueueFn(createApi(config), {
      sessionId: input.session_id,
      sessionsTable: config.sessionsTableName,
      drainAll: true,
    });
    logFn(`flush ${result.status}: rows=${result.rows} batches=${result.batches}`);
    return { status: "queued", entry, flushStatus: result.status };
  }

  return { status: "queued", entry };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<HookInput>();
  await runCaptureHook(input);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
