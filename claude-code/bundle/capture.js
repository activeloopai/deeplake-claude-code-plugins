#!/usr/bin/env node

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/src/utils/capture-queue.js
import { appendFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var QUEUE_DIR = join(homedir(), ".deeplake", "capture");
function ensureDir() {
  mkdirSync(QUEUE_DIR, { recursive: true });
}
function queuePath(sessionId) {
  return join(QUEUE_DIR, `${sessionId}.jsonl`);
}
function appendEvent(sessionId, event) {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(queuePath(sessionId), line);
}

// dist/src/utils/debug.js
import { appendFileSync as appendFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync2(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/capture.js
var log2 = (msg) => log("capture", msg);
var CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";
async function main() {
  if (!CAPTURE)
    return;
  const input = await readStdin();
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    hook_event_name: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    timestamp: ts
  };
  let entry;
  if (input.prompt !== void 0) {
    log2(`user session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt
    };
  } else if (input.tool_name !== void 0) {
    log2(`tool=${input.tool_name} session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response)
    };
  } else if (input.last_assistant_message !== void 0) {
    log2(`assistant session=${input.session_id}`);
    entry = {
      id: crypto.randomUUID(),
      ...meta,
      type: "assistant_message",
      content: input.last_assistant_message,
      ...input.agent_transcript_path ? { agent_transcript_path: input.agent_transcript_path } : {}
    };
  } else {
    log2("unknown event, skipping");
    return;
  }
  appendEvent(input.session_id, entry);
  log2("capture ok \u2192 local queue");
}
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
