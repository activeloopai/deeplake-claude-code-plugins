#!/usr/bin/env node

/**
 * Capture hook — writes each session event as a separate row in the sessions table.
 * One INSERT per event, no concat, no race conditions.
 *
 * Used by: UserPromptSubmit, PostToolUse (async), Stop, SubagentStop
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";
import { log as _log } from "../utils/debug.js";
import { buildSessionPath } from "../utils/session-path.js";
import {
  bumpTotalCount,
  loadTriggerConfig,
  shouldTrigger,
  tryAcquireLock,
  releaseLock,
} from "./summary-state.js";
import { bundleDirFromImportMeta, spawnWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingSqlLiteral } from "../embeddings/sql.js";
import { embeddingsDisabled } from "../embeddings/disable.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const log = (msg: string) => _log("capture", msg);

function resolveEmbedDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}

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

const CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<HookInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const sessionsTable = config.sessionsTableName;
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);

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
  log(`writing to ${sessionPath}`);

  // Simple INSERT — one row per event, no concat, no race conditions.
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  const filename = sessionPath.split("/").pop() ?? "";

  // For JSONB: only escape single quotes for the SQL literal, keep JSON structure intact.
  // sqlStr() would also escape backslashes and strip control chars, corrupting the JSON.
  const jsonForSql = line.replace(/'/g, "''");

  // Skip the daemon round-trip entirely when embeddings are globally disabled —
  // the column stays NULL, schema-compatible with future re-enabling.
  const embedding = embeddingsDisabled()
    ? null
    : await new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() }).embed(line, "document");
  const embeddingSql = embeddingSqlLiteral(embedding);

  const insertSql =
    `INSERT INTO "${sessionsTable}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, ${embeddingSql}, '${sqlStr(config.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(input.hook_event_name ?? "")}', 'claude_code', '${ts}', '${ts}')`;

  try {
    await api.query(insertSql);
  } catch (e: any) {
    // Fallback: table might not exist (session-start failed or org switched mid-session).
    // Create it and retry once.
    if (e.message?.includes("permission denied") || e.message?.includes("does not exist")) {
      log("table missing, creating and retrying");
      await api.ensureSessionsTable(sessionsTable);
      await api.query(insertSql);
    } else {
      throw e;
    }
  }

  log("capture ok → cloud");

  maybeTriggerPeriodicSummary(input.session_id, input.cwd ?? "", config);
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
    try {
      spawnWikiWorker({
        config,
        sessionId,
        cwd,
        bundleDir: bundleDirFromImportMeta(import.meta.url),
        reason: "Periodic",
      });
    } catch (e: any) {
      log(`periodic spawn failed: ${e.message}`);
      try {
        releaseLock(sessionId);
      } catch (releaseErr: any) {
        log(`releaseLock after periodic spawn failure also failed: ${releaseErr.message}`);
      }
      throw e;
    }
  } catch (e: any) {
    log(`periodic trigger error: ${e.message}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
