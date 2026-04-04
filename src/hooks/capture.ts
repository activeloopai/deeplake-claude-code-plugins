#!/usr/bin/env node

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("capture", msg);

interface HookInput {
  session_id: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  last_assistant_message?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  const input = await readStdin<HookInput>();
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
  const fs = await DeeplakeFs.create(api, table, "/");

  let entry: Record<string, unknown>;

  if (input.prompt !== undefined) {
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      session_id: input.session_id,
      type: "user_message",
      content: input.prompt,
      timestamp: new Date().toISOString(),
    };
  } else if (input.tool_name !== undefined) {
    log(`tool=${input.tool_name} session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      session_id: input.session_id,
      type: "tool_call",
      tool_name: input.tool_name,
      content: JSON.stringify(input.tool_input).slice(0, 5000),
      tool_response: JSON.stringify(input.tool_response).slice(0, 5000),
      timestamp: new Date().toISOString(),
    };
  } else if (input.last_assistant_message !== undefined) {
    log(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      session_id: input.session_id,
      type: "assistant_message",
      content: input.last_assistant_message,
      timestamp: new Date().toISOString(),
    };
  } else {
    log("unknown event, skipping");
    return;
  }

  const filename = `session_${input.session_id}.jsonl`;
  await fs.appendFile(`/${filename}`, JSON.stringify(entry) + "\n");
  await fs.flush();
  log("capture ok → cloud");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
