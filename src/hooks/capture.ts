#!/usr/bin/env node

/**
 * Capture hook — appends each session event to a local JSONL queue file.
 * No network calls — events are flushed to cloud at session end by the wiki worker.
 *
 * Used by: UserPromptSubmit, PostToolUse (async), Stop, SubagentStop
 *
 * Queue file: ~/.deeplake/capture/<sessionId>.jsonl
 */

import { readStdin } from "../utils/stdin.js";
import { appendEvent } from "../utils/capture-queue.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("capture", msg);

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  // Stop / SubagentStop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  agent_transcript_path?: string;
}

const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

async function main(): Promise<void> {
  if (!CAPTURE) return;
  const input = await readStdin<HookInput>();

  const ts = new Date().toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp: ts,
  };

  let entry: Record<string, unknown>;

  if (input.prompt !== undefined) {
    log(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt,
    };
  } else if (input.tool_name !== undefined) {
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
  } else if (input.last_assistant_message !== undefined) {
    log(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...(input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}),
    };
  } else {
    log("unknown event, skipping");
    return;
  }

  appendEvent(input.session_id, entry);
  log("capture ok → local queue");
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
