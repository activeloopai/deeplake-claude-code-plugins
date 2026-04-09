#!/usr/bin/env node

/**
 * Capture hook — writes each session event as a separate row in the sessions table.
 * One INSERT per event, no concat, no race conditions.
 *
 * Used by: UserPromptSubmit, PostToolUse (async), Stop, SubagentStop
 */

import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";
import { log as _log } from "../utils/debug.js";
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

const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

/** Build the session path matching the CLI convention:
 *  /sessions/<username>/<username>_<org>_<workspace>_<slug>.jsonl */
function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  const userName = config.userName;
  const orgName = config.orgName;
  const workspace = config.workspaceId ?? "default";

  return `/sessions/${userName}/${userName}_${orgName}_${workspace}_${sessionId}.jsonl`;
}

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

  await api.query(
    `INSERT INTO "${sessionsTable}" (id, path, filename, content_text, size_bytes, project, description, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(input.hook_event_name ?? "")}', '${ts}', '${ts}')`
  );

  log("capture ok → cloud");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
