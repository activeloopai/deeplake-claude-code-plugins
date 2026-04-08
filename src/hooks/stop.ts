#!/usr/bin/env node

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("stop", msg);

interface StopInput {
  session_id: string;
  last_assistant_message: string;
  stop_hook_active?: boolean;
}

const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<StopInput>();
  log(`session=${input.session_id} response=${(input.last_assistant_message ?? "").slice(0, 100)}`);

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
    type: "assistant_message",
    content: input.last_assistant_message ?? "",
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
