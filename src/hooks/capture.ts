#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
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

/** Build the session JSONL path matching the CLI convention:
 *  /sessions/<username>/<username>_<org>_<workspace>_<slug>.jsonl */
function buildSessionPath(config: { orgId: string; workspaceId: string }, sessionId: string): string {
  // Try to get userName from credentials.json (may have been saved by auth flow)
  let userName = "user";
  let orgName = "org";
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), ".deeplake", "credentials.json"), "utf-8"));
    userName = creds.userName ?? userInfo().username ?? "user";
    orgName = creds.orgName ?? "org";
  } catch {
    userName = userInfo().username ?? "user";
  }
  const workspace = config.workspaceId ?? "default";

  // Try to extract slug from local Claude JSONL
  let slug = sessionId;
  try {
    const projectsDir = join(homedir(), ".claude", "projects");
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      try {
        const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`);
        const content = readFileSync(jsonlPath, "utf-8");
        const match = content.match(/"slug":"([^"]*)"/);
        if (match) { slug = match[1]; break; }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return `/sessions/${userName}/${userName}_${orgName}_${workspace}_${slug}.jsonl`;
}

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<HookInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
  const fs = await DeeplakeFs.create(api, table, "/");

  // Common metadata for all entries
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp: new Date().toISOString(),
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
      // SubagentStop fields
      ...(input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}),
    };
  } else {
    log("unknown event, skipping");
    return;
  }

  const sessionPath = buildSessionPath(config, input.session_id);
  log(`writing to ${sessionPath}`);

  // Ensure sessions directory exists
  const dir = sessionPath.substring(0, sessionPath.lastIndexOf("/"));
  try { await fs.mkdir("/sessions"); } catch { /* exists */ }
  try { await fs.mkdir(dir); } catch { /* exists */ }

  await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n");
  await fs.flush();
  log("capture ok → cloud");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
