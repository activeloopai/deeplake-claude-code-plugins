#!/usr/bin/env node

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");

function log(msg: string) {
  appendFileSync(LOG, `${new Date().toISOString()} [post] ${msg}\n`);
}

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

  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

  const entry = {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    tool_name: input.tool_name,
    tool_input: JSON.stringify(input.tool_input).slice(0, 5000),
    tool_response: JSON.stringify(input.tool_response).slice(0, 5000),
    timestamp: new Date().toISOString(),
  };

  const file = join(MEMORY_DIR, `session_${input.session_id}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n");
  log("capture ok → " + file);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
