#!/usr/bin/env node

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("capture", msg);

interface HookInput {
  session_id: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  // Stop
  last_assistant_message?: string;
  // Common
  hook_event_name?: string;
}

async function main(): Promise<void> {
  const input = await readStdin<HookInput>();
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

  let entry: Record<string, unknown>;

  if (input.prompt !== undefined) {
    // UserPromptSubmit
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      session_id: input.session_id,
      type: "user_message",
      content: input.prompt,
      timestamp: new Date().toISOString(),
    };
  } else if (input.tool_name !== undefined) {
    // PostToolUse
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
    // Stop
    log(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      session_id: input.session_id,
      type: "assistant_message",
      content: input.last_assistant_message,
      timestamp: new Date().toISOString(),
    };
  } else {
    log(`unknown event, skipping`);
    return;
  }

  const file = join(MEMORY_DIR, `session_${input.session_id}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n");
  log("capture ok");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
