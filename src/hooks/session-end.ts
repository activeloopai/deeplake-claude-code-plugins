#!/usr/bin/env node

/**
 * SessionEnd hook — spawns a background worker that builds the session summary.
 *
 * The hook writes a config file and spawns the bundled wiki-worker.js process.
 * It exits immediately — no API calls, no timeout risk.
 * All heavy work (fetching events, running claude -p, uploading) happens in the worker.
 */

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { log as _log, utcTimestamp } from "../utils/debug.js";

const log = (msg: string) => _log("session-end", msg);

const HOME = homedir();
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");
const __bundleDir = dirname(fileURLToPath(import.meta.url));

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

function findClaudeBin(): string {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join(HOME, ".claude", "local", "claude");
  }
}

const WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge — entities, decisions, relationships, and facts — into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

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

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled — copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-3 dense sentences. What was the goal, what was accomplished, what's left.>

## People
<For each person mentioned: name, role, what they did/said. Format: **Name** — role — action>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs.
Format: **entity** (type) — what was done with it, its current state>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W">

## Key Facts
<Bullet list of atomic facts that could answer future questions. Each fact should stand alone.
Example: "- The memory table uses DELETE+INSERT, not UPDATE (WASM doesn't support upsert)">

## Files Modified
<bullet list: path (new/modified/deleted) — what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact. Future you will search this wiki to answer questions like "who worked on X", "why did we choose Y", "what's the status of Z". If a detail exists in the session, it should be in the wiki.

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct — do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise — prioritize facts over prose. If a session is short, the summary should be short too.`;

async function main(): Promise<void> {
  // Skip if this is a sub-session spawned by the wiki worker itself
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;
  // Skip when capture is disabled (e.g. benchmark runs)
  if (process.env.DEEPLAKE_CAPTURE === "false") return;

  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const memoryTable = config.tableName;
  const sessionsTable = config.sessionsTableName;
  const claudeBin = findClaudeBin();
  const projectName = cwd.split("/").pop() || "unknown";

  // Write config and spawn the bundled wiki worker — hook exits immediately.
  const tmpDir = join(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const configFile = join(tmpDir, "config.json");
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
    hooksDir: join(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
  }));

  wikiLog(`SessionEnd: spawning summary worker for ${sessionId}`);

  const workerPath = join(__bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  wikiLog(`SessionEnd: spawned summary worker for ${sessionId}`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
