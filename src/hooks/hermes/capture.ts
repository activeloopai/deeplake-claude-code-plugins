/**
 * Hermes capture hook — writes one row per event into the sessions table.
 *
 * Wired to: pre_llm_call (capture user prompt), post_tool_call (capture tool
 * call result), post_llm_call (capture assistant response).
 *
 * Hermes payload shape (from agent/shell_hooks.py docstring):
 *   { hook_event_name, tool_name?, tool_input?, session_id, cwd, extra? }
 *
 * Field locations differ from Claude/Cursor — most event-specific data lives
 * under `extra`:
 *   - pre_llm_call:  extra.prompt OR extra.user_message
 *   - post_tool_call: tool_name, tool_input, extra.tool_result OR extra.tool_output
 *   - post_llm_call: extra.response OR extra.assistant_message
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { log as _log } from "../../utils/debug.js";
import { buildSessionPath } from "../../utils/session-path.js";
import { resolveProjectName } from "../../utils/project-name.js";
const log = (msg: string) => _log("hermes-capture", msg);

interface HermesCaptureInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

const CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<HermesCaptureInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const sessionId = input.session_id ?? `hermes-${Date.now()}`;
  const event = input.hook_event_name ?? "";
  const cwd = input.cwd ?? "";
  const extra = (input.extra ?? {}) as Record<string, unknown>;

  const sessionsTable = config.sessionsTableName;
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);

  const ts = new Date().toISOString();
  const meta = {
    session_id: sessionId,
    cwd,
    hook_event_name: event,
    timestamp: ts,
  };

  let entry: Record<string, unknown> | null = null;

  if (event === "pre_llm_call") {
    const prompt = pickString(extra.prompt, extra.user_message, (extra.message as Record<string, unknown> | undefined)?.content);
    if (!prompt) { log(`pre_llm_call: no prompt found in extra`); return; }
    log(`user session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "user_message", content: prompt };
  } else if (event === "post_tool_call" && typeof input.tool_name === "string") {
    const toolResponse = extra.tool_result ?? extra.tool_output ?? extra.result ?? extra.output;
    log(`tool=${input.tool_name} session=${sessionId}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse ?? null),
    };
  } else if (event === "post_llm_call") {
    const text = pickString(extra.response, extra.assistant_message, (extra.message as Record<string, unknown> | undefined)?.content);
    if (!text) { log(`post_llm_call: no response found in extra`); return; }
    log(`assistant session=${sessionId}`);
    entry = { id: crypto.randomUUID(), ...meta, type: "assistant_message", content: text };
  } else {
    log(`unknown/unhandled event: ${event}, skipping`);
    return;
  }

  const sessionPath = buildSessionPath(config, sessionId);
  const line = JSON.stringify(entry);
  log(`writing to ${sessionPath}`);

  const projectName = resolveProjectName(cwd);
  const filename = sessionPath.split("/").pop() ?? "";
  // For JSONB: only escape single quotes, keep JSON structure intact.
  const jsonForSql = line.replace(/'/g, "''");

  const insertSql =
    `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(config.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(event)}', 'hermes', '${ts}', '${ts}')`;

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
