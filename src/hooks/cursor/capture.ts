#!/usr/bin/env node

/**
 * Cursor capture hook — writes one row per event into the sessions table.
 *
 * Wired to: beforeSubmitPrompt, postToolUse, afterAgentResponse, stop.
 *
 * Cursor input fields differ from Claude/Codex:
 *   common: conversation_id, hook_event_name, model, workspace_roots, transcript_path
 *   beforeSubmitPrompt: prompt, attachments
 *   postToolUse: tool_name, tool_input, tool_output (string), tool_use_id, cwd, duration
 *   afterAgentResponse: text
 *   stop: status, loop_count
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { log as _log } from "../../utils/debug.js";
import { buildSessionPath } from "../../utils/session-path.js";
const log = (msg: string) => _log("cursor-capture", msg);

interface CursorCaptureInput {
  conversation_id?: string;
  hook_event_name?: string;
  model?: string;
  workspace_roots?: string[];
  transcript_path?: string | null;
  // beforeSubmitPrompt
  prompt?: string;
  // postToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  tool_use_id?: string;
  cwd?: string;
  duration?: number;
  // afterAgentResponse
  text?: string;
  // stop
  status?: string;
  loop_count?: number;
}

const CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";

function resolveCwd(input: CursorCaptureInput): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") return roots[0];
  return "";
}

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<CursorCaptureInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const sessionId = input.conversation_id ?? `cursor-${Date.now()}`;
  const event = input.hook_event_name ?? "";
  const cwd = resolveCwd(input);

  const sessionsTable = config.sessionsTableName;
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);

  const ts = new Date().toISOString();
  const meta = {
    session_id: sessionId,
    transcript_path: input.transcript_path,
    cwd,
    hook_event_name: event,
    model: input.model,
    timestamp: ts,
  };

  let entry: Record<string, unknown> | null = null;

  if (event === "beforeSubmitPrompt" && typeof input.prompt === "string") {
    log(`user session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "user_message", content: input.prompt };
  } else if (event === "postToolUse" && typeof input.tool_name === "string") {
    log(`tool=${input.tool_name} session=${sessionId}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      // Cursor delivers tool_output as a JSON-encoded string already.
      tool_response: typeof input.tool_output === "string" ? input.tool_output : JSON.stringify(input.tool_output),
    };
  } else if (event === "afterAgentResponse" && typeof input.text === "string") {
    log(`assistant session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "assistant_message", content: input.text };
  } else if (event === "stop") {
    log(`stop session=${sessionId} status=${input.status ?? "unknown"}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "stop",
      status: input.status,
      loop_count: input.loop_count,
    };
  } else {
    log(`unknown event: ${event}, skipping`);
    return;
  }

  const sessionPath = buildSessionPath(config, sessionId);
  const line = JSON.stringify(entry);
  log(`writing to ${sessionPath}`);

  const projectName = cwd.split("/").pop() || "unknown";
  const filename = sessionPath.split("/").pop() ?? "";
  // For JSONB: only escape single quotes, keep JSON structure intact.
  // sqlStr() would also escape backslashes and corrupt the JSON.
  const jsonForSql = line.replace(/'/g, "''");

  const insertSql =
    `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(config.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(event)}', 'cursor', '${ts}', '${ts}')`;

  try {
    await api.query(insertSql);
  } catch (e: any) {
    if (e.message?.includes("permission denied") || e.message?.includes("does not exist")) {
      log("table missing, creating and retrying");
      await api.ensureSessionsTable(sessionsTable);
      await api.query(insertSql);
    } else {
      throw e;
    }
  }

  log("capture ok → cloud");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
