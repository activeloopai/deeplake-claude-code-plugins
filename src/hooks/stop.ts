#!/usr/bin/env node

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("stop", msg);

interface StopInput {
  session_id: string;
  last_assistant_message: string;
  stop_hook_active?: boolean;
}

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  log(`session=${input.session_id} response=${(input.last_assistant_message ?? "").slice(0, 100)}`);

  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

  const entry = {
    id: crypto.randomUUID(),
    session_id: input.session_id,
    type: "assistant_message",
    content: input.last_assistant_message ?? "",
    timestamp: new Date().toISOString(),
  };

  const file = join(MEMORY_DIR, `session_${input.session_id}.jsonl`);
  appendFileSync(file, JSON.stringify(entry) + "\n");
  log("capture ok");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
