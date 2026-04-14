#!/usr/bin/env node

// dist/src/hooks/codex/stop.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as join4 } from "node:path";
import { writeFileSync, readFileSync as readFileSync3, mkdirSync as mkdirSync2, appendFileSync as appendFileSync3, existsSync as existsSync3 } from "node:fs";
import { homedir as homedir4, tmpdir } from "node:os";

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

// dist/src/config.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
function loadConfig() {
  const home = homedir();
  const credPath = join(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch {
      return null;
    }
  }
  const token = process.env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = process.env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: process.env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    memoryPath: process.env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/utils/capture-queue.js
import { appendFileSync, mkdirSync, readFileSync as readFileSync2, existsSync as existsSync2, unlinkSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var QUEUE_DIR = join2(homedir2(), ".deeplake", "capture");
function ensureDir() {
  mkdirSync(QUEUE_DIR, { recursive: true });
}
function queuePath(sessionId) {
  return join2(QUEUE_DIR, `${sessionId}.jsonl`);
}
function appendEvent(sessionId, event) {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(queuePath(sessionId), line);
}

// dist/src/utils/debug.js
import { appendFileSync as appendFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
var LOG = join3(homedir3(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync2(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/codex/stop.js
var log2 = (msg) => log("codex-stop", msg);
var HOME = homedir4();
var WIKI_LOG = join4(HOME, ".codex", "hooks", "deeplake-wiki.log");
var __bundleDir = dirname(fileURLToPath(import.meta.url));
function wikiLog(msg) {
  try {
    mkdirSync2(join4(HOME, ".codex", "hooks"), { recursive: true });
    appendFileSync3(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
function findSummaryBin() {
  try {
    return execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "codex";
  }
}
var WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry.

SESSION JSONL path: __JSONL__
SUMMARY FILE to write: __SUMMARY__
SESSION ID: __SESSION_ID__
PROJECT: __PROJECT__
PREVIOUS JSONL OFFSET (lines already processed): __PREV_OFFSET__
CURRENT JSONL LINES: __JSONL_LINES__

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this EXACT format:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-3 dense sentences. What was the goal, what was accomplished, what's left.>

## People
<For each person mentioned: name, role, what they did/said. Format: **Name** \u2014 role \u2014 action>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs.
Format: **entity** (type) \u2014 what was done with it, its current state>

## Decisions & Reasoning
<Every decision made and WHY.>

## Key Facts
<Bullet list of atomic facts that could answer future questions.>

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact.
PRIVACY: Never include absolute filesystem paths in the summary.
LENGTH LIMIT: Keep the total summary under 4000 characters.`;
var CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";
async function main() {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  const sessionId = input.session_id;
  if (!sessionId)
    return;
  const config = loadConfig();
  if (!config) {
    log2("no config");
    return;
  }
  if (CAPTURE) {
    try {
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      let lastAssistantMessage = "";
      if (input.transcript_path) {
        try {
          const transcriptPath = input.transcript_path;
          if (existsSync3(transcriptPath)) {
            const transcript = readFileSync3(transcriptPath, "utf-8");
            const lines = transcript.trim().split("\n").reverse();
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                const msg = entry.payload ?? entry;
                if (msg.role === "assistant" && msg.content) {
                  const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((b) => b.type === "output_text" || b.type === "text").map((b) => b.text).join("\n") : "";
                  if (content) {
                    lastAssistantMessage = content.slice(0, 4e3);
                    break;
                  }
                }
              } catch {
              }
            }
            if (lastAssistantMessage)
              log2(`extracted assistant message from transcript (${lastAssistantMessage.length} chars)`);
          }
        } catch (e) {
          log2(`transcript read failed: ${e.message}`);
        }
      }
      appendEvent(sessionId, {
        id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        model: input.model,
        timestamp: ts,
        type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
        content: lastAssistantMessage
      });
      log2("stop event captured \u2192 local queue");
    } catch (e) {
      log2(`capture failed: ${e.message}`);
    }
  }
  const cwd = input.cwd ?? "";
  const memoryTable = config.tableName;
  const sessionsTable = config.sessionsTableName;
  const agentBin = findSummaryBin();
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join4(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync2(tmpDir, { recursive: true });
  const configFile = join4(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    orgName: config.orgName,
    workspaceId: config.workspaceId,
    memoryTable,
    sessionsTable,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    codexBin: agentBin,
    wikiLog: WIKI_LOG,
    hooksDir: join4(HOME, ".codex", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`Stop: spawning summary worker for ${sessionId}`);
  const workerPath = join4(__bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`Stop: spawned summary worker for ${sessionId}`);
}
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
