#!/usr/bin/env node

/**
 * Codex Stop hook — handles both capture and session-end (wiki summary spawn).
 *
 * Codex has no SessionEnd event, so this hook does double duty:
 * 1. Captures the stop event to the sessions table
 * 2. Spawns the wiki worker to generate the session summary
 */

import { readFileSync, existsSync } from "node:fs";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig, type Config } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { bundleDirFromImportMeta, spawnCodexWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import {
  appendQueuedSessionRow,
  buildQueuedSessionRow,
  buildSessionPath,
  flushSessionQueue,
} from "../session-queue.js";

const log = (msg: string) => _log("codex-stop", msg);

export interface CodexStopInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
}

const CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";

export function extractLastAssistantMessage(transcript: string): string {
  const lines = transcript.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.payload ?? entry;
      if (msg.role === "assistant" && msg.content) {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
              .filter((b: any) => b.type === "output_text" || b.type === "text")
              .map((b: any) => b.text)
              .join("\n")
            : "";
        if (content) return content.slice(0, 4000);
      }
    } catch { /* skip malformed line */ }
  }
  return "";
}

export function buildCodexStopEntry(input: CodexStopInput, timestamp: string, lastAssistantMessage: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    model: input.model,
    timestamp,
    type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
    content: lastAssistantMessage,
  };
}

interface CodexStopDeps {
  wikiWorker?: boolean;
  captureEnabled?: boolean;
  config?: Config | null;
  now?: () => string;
  transcriptExists?: (path: string) => boolean;
  readTranscript?: (path: string) => string;
  createApi?: (config: Config) => DeeplakeApi;
  appendQueuedSessionRowFn?: typeof appendQueuedSessionRow;
  buildQueuedSessionRowFn?: typeof buildQueuedSessionRow;
  flushSessionQueueFn?: typeof flushSessionQueue;
  spawnCodexWikiWorkerFn?: typeof spawnCodexWikiWorker;
  wikiLogFn?: typeof wikiLog;
  bundleDir?: string;
  logFn?: (msg: string) => void;
}

export async function runCodexStopHook(input: CodexStopInput, deps: CodexStopDeps = {}): Promise<{
  status: "skipped" | "no_config" | "complete";
  flushStatus?: string;
  entry?: Record<string, unknown>;
}> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    captureEnabled = CAPTURE,
    config = loadConfig(),
    now = () => new Date().toISOString(),
    transcriptExists = existsSync,
    readTranscript = (path) => readFileSync(path, "utf-8"),
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
    spawnCodexWikiWorkerFn = spawnCodexWikiWorker,
    wikiLogFn = wikiLog,
    bundleDir = bundleDirFromImportMeta(import.meta.url),
    logFn = log,
  } = deps;

  if (wikiWorker || !input.session_id) return { status: "skipped" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }

  let entry: Record<string, unknown> | undefined;
  let flushStatus: string | undefined;

  if (captureEnabled) {
    try {
      const ts = now();
      let lastAssistantMessage = "";
      if (input.transcript_path) {
        try {
          if (transcriptExists(input.transcript_path)) {
            lastAssistantMessage = extractLastAssistantMessage(readTranscript(input.transcript_path));
            if (lastAssistantMessage) {
              logFn(`extracted assistant message from transcript (${lastAssistantMessage.length} chars)`);
            }
          }
        } catch (e: any) {
          logFn(`transcript read failed: ${e.message}`);
        }
      }

      entry = buildCodexStopEntry(input, ts, lastAssistantMessage);
      const line = JSON.stringify(entry);
      const sessionPath = buildSessionPath(config, input.session_id);
      const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
      appendQueuedSessionRowFn(buildQueuedSessionRowFn({
        sessionPath,
        line,
        userName: config.userName,
        projectName,
        description: "Stop",
        agent: "codex",
        timestamp: ts,
      }));

      const flush = await flushSessionQueueFn(createApi(config), {
        sessionId: input.session_id,
        sessionsTable: config.sessionsTableName,
        drainAll: true,
      });
      flushStatus = flush.status;
      logFn(`stop flush ${flush.status}: rows=${flush.rows} batches=${flush.batches}`);
    } catch (e: any) {
      logFn(`capture failed: ${e.message}`);
    }
  }

  if (!captureEnabled) return { status: "complete", entry };

  wikiLogFn(`Stop: triggering summary for ${input.session_id}`);
  spawnCodexWikiWorkerFn({
    config,
    sessionId: input.session_id,
    cwd: input.cwd ?? "",
    bundleDir,
    reason: "Stop",
  });

  return { status: "complete", flushStatus, entry };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexStopInput>();
  await runCodexStopHook(input);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
