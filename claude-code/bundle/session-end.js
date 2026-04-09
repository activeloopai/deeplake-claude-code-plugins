#!/usr/bin/env node

// ../dist/src/hooks/session-end.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync as appendFileSync2 } from "node:fs";
import { homedir as homedir3, tmpdir } from "node:os";

// ../dist/src/utils/stdin.js
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

// ../dist/src/config.js
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

// ../dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// ../dist/src/hooks/session-end.js
var log2 = (msg) => log("session-end", msg);
var HOME = homedir3();
var WIKI_LOG = join3(HOME, ".claude", "hooks", "deeplake-wiki.log");
var __bundleDir = dirname(fileURLToPath(import.meta.url));
function wikiLog(msg) {
  try {
    mkdirSync(join3(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
function findClaudeBin() {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join3(HOME, ".claude", "local", "claude");
  }
}
var WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

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

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled \u2014 copy them VERBATIM, do NOT replace them with paths from the JSONL content:

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
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W">

## Key Facts
<Bullet list of atomic facts that could answer future questions. Each fact should stand alone.
Example: "- The memory table uses DELETE+INSERT, not UPDATE (WASM doesn't support upsert)">

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact. Future you will search this wiki to answer questions like "who worked on X", "why did we choose Y", "what's the status of Z". If a detail exists in the session, it should be in the wiki.

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct \u2014 do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise \u2014 prioritize facts over prose. If a session is short, the summary should be short too.`;
async function main() {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId)
    return;
  const config = loadConfig();
  if (!config) {
    log2("no config");
    return;
  }
  const memoryTable = config.tableName;
  const sessionsTable = config.sessionsTableName;
  const claudeBin = findClaudeBin();
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join3(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const configFile = join3(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable,
    sessionsTable,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    claudeBin,
    wikiLog: WIKI_LOG,
    hooksDir: join3(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`SessionEnd: spawning summary worker for ${sessionId}`);
  const workerPath = join3(__bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`SessionEnd: spawned summary worker for ${sessionId}`);
}
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
