#!/usr/bin/env node

/**
 * Codex Capture hook — appends session events to a local queue on the hot path.
 *
 * Used by: UserPromptSubmit, PostToolUse
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig, type Config } from "../../config.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";
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

export interface CodexHookInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
  tool_response?: Record<string, unknown>;
}

const CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";

export function buildCodexCaptureEntry(input: CodexHookInput, timestamp: string): Record<string, unknown> | null {
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    model: input.model,
    turn_id: input.turn_id,
    timestamp,
  };

  if (input.hook_event_name === "UserPromptSubmit" && input.prompt !== undefined) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  }

  if (input.hook_event_name === "PostToolUse" && input.tool_name !== undefined) {
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
  spawnCodexWikiWorkerFn?: typeof spawnCodexWikiWorker;
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
    spawnCodexWikiWorkerFn = spawnCodexWikiWorker,
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
    spawnCodexWikiWorkerFn({
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

interface CodexCaptureDeps {
  captureEnabled?: boolean;
  config?: Config | null;
  now?: () => string;
  appendQueuedSessionRowFn?: typeof appendQueuedSessionRow;
  buildQueuedSessionRowFn?: typeof buildQueuedSessionRow;
  maybeTriggerPeriodicSummaryFn?: typeof maybeTriggerPeriodicSummary;
  logFn?: (msg: string) => void;
}

export async function runCodexCaptureHook(input: CodexHookInput, deps: CodexCaptureDeps = {}): Promise<{
  status: "disabled" | "no_config" | "ignored" | "queued";
  entry?: Record<string, unknown>;
}> {
  const {
    captureEnabled = CAPTURE,
    config = loadConfig(),
    now = () => new Date().toISOString(),
    appendQueuedSessionRowFn = appendQueuedSessionRow,
    buildQueuedSessionRowFn = buildQueuedSessionRow,
    maybeTriggerPeriodicSummaryFn = maybeTriggerPeriodicSummary,
    logFn = log,
  } = deps;

  if (!captureEnabled) return { status: "disabled" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }

  const ts = now();
  const entry = buildCodexCaptureEntry(input, ts);
  if (!entry) {
    logFn(`unknown event: ${input.hook_event_name}, skipping`);
    return { status: "ignored" };
  }

  if (input.hook_event_name === "UserPromptSubmit") logFn(`user session=${input.session_id}`);
  else logFn(`tool=${input.tool_name} session=${input.session_id}`);

  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRowFn(buildQueuedSessionRowFn({
    sessionPath,
    line,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "codex",
    timestamp: ts,
  }));
  logFn(`queued ${input.hook_event_name} for ${sessionPath}`);

  maybeTriggerPeriodicSummaryFn(input.session_id, input.cwd ?? "", config);
  return { status: "queued", entry };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexHookInput>();
  await runCodexCaptureHook(input);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
