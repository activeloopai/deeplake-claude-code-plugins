#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";

const MEMORY_DIR = process.env.DEEPLAKE_MEMORY_DIR ?? join(homedir(), ".deeplake", "memory");
const CACHE_DIR = join(homedir(), ".deeplake", ".cache");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");
const DEBUG = process.env.DEEPLAKE_DEBUG === "1";
const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

function log(msg: string) {
  if (!DEBUG) return;
  appendFileSync(LOG, `${new Date().toISOString()} [stop] ${msg}\n`);
}

interface StopInput {
  session_id: string;
  last_assistant_message: string;
  stop_hook_active?: boolean;
}

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  log(`session=${input.session_id}`);

  // Clean up bootstrap cache for this session
  try {
    const cachePath = join(CACHE_DIR, `bootstrap-${input.session_id}.json`);
    if (existsSync(cachePath)) {
      rmSync(cachePath);
      log(`cache cleaned: ${cachePath}`);
    }
  } catch { /* non-fatal */ }

  if (!CAPTURE) return;

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

main().catch((e) => { log(`fatal: ${e instanceof Error ? e.message : e}`); process.exit(0); });
