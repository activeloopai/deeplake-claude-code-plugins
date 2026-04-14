#!/usr/bin/env node

/**
 * Codex Capture hook — appends each session event to a local JSONL queue file.
 * No network calls — events are flushed to cloud at session end by the wiki worker.
 *
 * Used by: UserPromptSubmit, PostToolUse
 *
 * Queue file: ~/.deeplake/capture/<sessionId>.jsonl
 */

import { readStdin } from "../../utils/stdin.js";
import { appendEvent } from "../../utils/capture-queue.js";
import { log as _log } from "../../utils/debug.js";
const log = (msg: string) => _log("codex-capture", msg);

interface CodexHookInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse (Bash only in Codex)
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
  tool_response?: Record<string, unknown>;
}

const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<CodexHookInput>();

  const ts = new Date().toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    model: input.model,
    turn_id: input.turn_id,
    timestamp: ts,
  };

  let entry: Record<string, unknown>;

  if (input.hook_event_name === "UserPromptSubmit" && input.prompt !== undefined) {
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  } else if (input.hook_event_name === "PostToolUse" && input.tool_name !== undefined) {
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
  } else {
    log(`unknown event: ${input.hook_event_name}, skipping`);
    return;
  }

  appendEvent(input.session_id, entry);
  log("capture ok → local queue");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
