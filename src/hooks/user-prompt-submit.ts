#!/usr/bin/env node

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(msg: string) {
  appendFileSync(LOG, `${new Date().toISOString()} [user] ${msg}\n`);
}

interface UserPromptSubmitInput {
  session_id: string;
  prompt: string;
}

async function main(): Promise<void> {
  const input = await readStdin<UserPromptSubmitInput>();
  log(`session=${input.session_id} prompt=${input.prompt.slice(0, 100)}`);

  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

  const entry = {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    type: "user_message",
    content: input.prompt,
    timestamp: new Date().toISOString(),
  };

  const file = join(MEMORY_DIR, `session_${input.session_id}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n");
  log("capture ok");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
