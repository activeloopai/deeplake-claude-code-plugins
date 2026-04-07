#!/usr/bin/env node

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("post", msg);

interface PostToolUseInput {
  session_id: string;
  transcript_path: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  log(`tool=${input.tool_name} session=${input.session_id}`);

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
  const fs = await DeeplakeFs.create(api, table, "/");

  const userName = config.userName ?? "user";
  const sessionPath = `/sessions/${userName}/${userName}_${config.orgName ?? config.orgId}_${config.workspaceId}_${input.session_id}.jsonl`;

  const entry = {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    tool_name: input.tool_name,
    tool_input: JSON.stringify(input.tool_input).slice(0, 5000),
    tool_response: JSON.stringify(input.tool_response).slice(0, 5000),
    timestamp: new Date().toISOString(),
  };

  try { await fs.mkdir("/sessions"); } catch { /* exists */ }
  try { await fs.mkdir(`/sessions/${userName}`); } catch { /* exists */ }
  await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n");
  await fs.flush();
  log("capture ok → cloud");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
