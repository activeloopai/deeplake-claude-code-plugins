#!/usr/bin/env node

/**
 * Codex Stop hook — handles both capture and session-end (wiki summary spawn).
 *
 * Codex has no SessionEnd event, so this hook does double duty:
 * 1. Captures the stop event to the sessions table (like capture.ts)
 * 2. Spawns the wiki worker to generate the session summary (like session-end.ts)
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model }
 * Codex output: JSON with optional { decision: "block", reason: "..." } to continue
 */

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("codex-stop", msg);

const HOME = homedir();
const WIKI_LOG = join(HOME, ".codex", "hooks", "deeplake-wiki.log");
const __bundleDir = dirname(fileURLToPath(import.meta.url));

interface CodexStopInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
}

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".codex", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}\n`);
  } catch { /* ignore */ }
}

function findSummaryBin(): string {
  try {
    return execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "codex";
  }
}

const WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge — entities, decisions, relationships, and facts — into a structured, searchable wiki entry.

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
<For each person mentioned: name, role, what they did/said. Format: **Name** — role — action>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs.
Format: **entity** (type) — what was done with it, its current state>

## Decisions & Reasoning
<Every decision made and WHY.>

## Key Facts
<Bullet list of atomic facts that could answer future questions.>

## Files Modified
<bullet list: path (new/modified/deleted) — what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact.
PRIVACY: Never include absolute filesystem paths in the summary.
LENGTH LIMIT: Keep the total summary under 4000 characters.`;

const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";

function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}

async function main(): Promise<void> {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexStopInput>();
  const sessionId = input.session_id;
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  // 1. Capture the stop event (try to extract last assistant message from transcript)
  if (CAPTURE) {
    try {
      const sessionsTable = config.sessionsTableName;
      const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);
      const ts = new Date().toISOString();

      // Codex Stop doesn't include last_assistant_message, but it provides
      // transcript_path. Try to extract the last assistant message from it.
      let lastAssistantMessage = "";
      if (input.transcript_path) {
        try {
          const transcriptPath = input.transcript_path;
          if (existsSync(transcriptPath)) {
            const transcript = readFileSync(transcriptPath, "utf-8");
            // Codex transcript is JSONL with format:
            // {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
            const lines = transcript.trim().split("\n").reverse();
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                // Codex nests the message inside payload
                const msg = entry.payload ?? entry;
                if (msg.role === "assistant" && msg.content) {
                  const content = typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content.filter((b: any) => b.type === "output_text" || b.type === "text").map((b: any) => b.text).join("\n")
                      : "";
                  if (content) {
                    lastAssistantMessage = content.slice(0, 4000);
                    break;
                  }
                }
              } catch { /* skip malformed line */ }
            }
            if (lastAssistantMessage) log(`extracted assistant message from transcript (${lastAssistantMessage.length} chars)`);
          }
        } catch (e: any) {
          log(`transcript read failed: ${e.message}`);
        }
      }

      const entry = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        model: input.model,
        timestamp: ts,
        type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
        content: lastAssistantMessage,
      };
      const line = JSON.stringify(entry);
      const sessionPath = buildSessionPath(config, sessionId);
      const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
      const filename = sessionPath.split("/").pop() ?? "";
      const jsonForSql = sqlStr(line);

      const insertSql =
        `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
        `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(config.userName)}', ` +
        `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', 'Stop', 'codex', '${ts}', '${ts}')`;

      await api.query(insertSql);
      log("stop event captured");
    } catch (e: any) {
      log(`capture failed: ${e.message}`);
    }
  }

  // 2. Spawn wiki worker (session summary generation) — skip when capture disabled
  if (!CAPTURE) return;
  const cwd = input.cwd ?? "";
  const memoryTable = config.tableName;
  const sessionsTable = config.sessionsTableName;
  const agentBin = findSummaryBin();
  const projectName = cwd.split("/").pop() || "unknown";

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
    codexBin: agentBin,
    wikiLog: WIKI_LOG,
    hooksDir: join(HOME, ".codex", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
  }));

  wikiLog(`Stop: spawning summary worker for ${sessionId}`);

  // Reuse the same wiki-worker.js — it's platform-agnostic
  const workerPath = join(__bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  wikiLog(`Stop: spawned summary worker for ${sessionId}`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
