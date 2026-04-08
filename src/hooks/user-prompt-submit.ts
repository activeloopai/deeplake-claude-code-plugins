#!/usr/bin/env node

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("user-prompt", msg);

interface UserPromptSubmitInput {
  session_id: string;
  prompt: string;
}

async function main(): Promise<void> {
  const input = await readStdin<UserPromptSubmitInput>();
  log(`session=${input.session_id} prompt=${input.prompt.slice(0, 100)}`);

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
  const fs = await DeeplakeFs.create(api, table, "/");

  const userName = config.userName;
  const sessionPath = `/sessions/${userName}/${userName}_${config.orgName ?? config.orgId}_${config.workspaceId}_${input.session_id}.jsonl`;

  const entry = {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    type: "user_message",
    content: input.prompt,
    timestamp: new Date().toISOString(),
  };

  try { await fs.mkdir("/sessions"); } catch { /* exists */ }
  try { await fs.mkdir(`/sessions/${userName}`); } catch { /* exists */ }
  await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n");
  await fs.flush();
  log("capture ok → cloud");
  process.exit(0);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
