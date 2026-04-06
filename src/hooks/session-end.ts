#!/usr/bin/env node

/**
 * SessionEnd (Stop) hook — builds session summaries and index.
 * Direct port of deeplake-wiki.sh from the CLI.
 *
 * Reads session JSONL from Deeplake server (via DeeplakeFs), dumps to a temp
 * file, spawns claude -p to generate the summary to temp paths, then uploads
 * the results back to the server via DeeplakeFs.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, createWriteStream, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
import { sqlStr } from "../utils/sql.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("session-end", msg);

const HOME = homedir();
const MEMORY_PATH = join(HOME, ".deeplake", "memory");
const SUMMARIES_DIR = join(MEMORY_PATH, "summaries");
const INDEX_FILE = join(MEMORY_PATH, "index.md");
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

interface StopInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
}

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}\n`);
  } catch { /* ignore */ }
}

function findClaudeBin(): string {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join(HOME, ".claude", "local", "claude");
  }
}

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  // --- Read JSONL directly from Deeplake server via SQL (bypass DeeplakeFs cache) ---
  const config = loadConfig();
  if (!config) { log("no config"); return; }

  const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);

  // Find the session JSONL — matches CLI pattern: /sessions/<user>/<user>_<org>_<ws>_<slug>.jsonl
  // The slug may be the session ID or a project slug. Search by session ID in the path.
  const rows = await api.query(
    `SELECT path, content_text FROM "${table}" WHERE path LIKE '${sqlStr(`/sessions/%${sessionId}%`)}' LIMIT 1`
  );

  // Fallback: also check old plugin path /session_<id>.jsonl
  if (rows.length === 0) {
    const fallbackRows = await api.query(
      `SELECT path, content_text FROM "${table}" WHERE path = '${sqlStr(`/session_${sessionId}.jsonl`)}' LIMIT 1`
    );
    if (fallbackRows.length > 0) rows.push(...fallbackRows);
  }

  if (rows.length === 0 || !rows[0]["content_text"]) {
    wikiLog(`SessionEnd: no JSONL on server for ${sessionId}`);
    return;
  }

  const jsonlServerPath = rows[0]["path"] as string;
  const jsonlContent = rows[0]["content_text"] as string;
  wikiLog(`SessionEnd: found JSONL at ${jsonlServerPath}`);
  if (!jsonlContent.trim()) {
    wikiLog(`SessionEnd: empty JSONL for ${sessionId}`);
    return;
  }

  const jsonlLines = jsonlContent.split("\n").filter(Boolean).length;

  // Dump JSONL to temp file so claude -p can read it
  const tmpDir = join(tmpdir(), `deeplake-wiki-${sessionId}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpJsonl = join(tmpDir, "session.jsonl");
  const tmpSummary = join(tmpDir, "summary.md");
  const tmpIndex = join(tmpDir, "index.md");
  writeFileSync(tmpJsonl, jsonlContent);

  wikiLog(`SessionEnd: processing ${sessionId} (${jsonlLines} lines, tmp: ${tmpDir})`);

  // Check if summary already exists on server (resumed session) — extract JSONL offset
  let prevOffset = 0;
  try {
    const sumRows = await api.query(
      `SELECT content_text FROM "${table}" WHERE path = '${sqlStr(`/summaries/${sessionId}.md`)}' LIMIT 1`
    );
    if (sumRows.length > 0 && sumRows[0]["content_text"]) {
      const existing = sumRows[0]["content_text"] as string;
      const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
      if (match) prevOffset = parseInt(match[1], 10);
      writeFileSync(tmpSummary, existing);
    }
  } catch { /* no existing summary */ }

  // Read existing index from server
  try {
    const idxRows = await api.query(
      `SELECT content_text FROM "${table}" WHERE path = '/index.md' LIMIT 1`
    );
    if (idxRows.length > 0 && idxRows[0]["content_text"]) {
      writeFileSync(tmpIndex, idxRows[0]["content_text"] as string);
    }
  } catch { /* no existing index */ }

  const claudeBin = findClaudeBin();

  // Build the prompt — Karpathy-style personal wiki generation
  const wikiPrompt = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge — entities, decisions, relationships, and facts — into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

SESSION JSONL path: ${tmpJsonl}
SUMMARY FILE to write: ${tmpSummary}
INDEX FILE to update: ${tmpIndex}
SESSION ID: ${sessionId}
PROJECT: ${cwd}
PREVIOUS JSONL OFFSET (lines already processed): ${prevOffset}
CURRENT JSONL LINES: ${jsonlLines}

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this format:

# Session ${sessionId}
- **Source**: ${jsonlServerPath}
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: ${cwd}
- **JSONL offset**: ${jsonlLines}

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

3. Update the index file: find the line containing ${sessionId} and replace it with:
| [${sessionId}](summaries/${sessionId}.md) | <date> | <project> | <short 1-line description max 80 chars> |

If the line does not exist, append it.

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact. Future you will search this wiki to answer questions like "who worked on X", "why did we choose Y", "what's the status of Z". If a detail exists in the session, it should be in the wiki.`;

  // Write prompt to a file to avoid shell escaping issues
  const promptFile = join(tmpDir, "prompt.txt");
  writeFileSync(promptFile, wikiPrompt);

  // Write config for upload script
  const configFile = join(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    table,
    sessionId,
    summaryPath: tmpSummary,
    indexPath: tmpIndex,
    summariesDir: SUMMARIES_DIR,
    indexFile: INDEX_FILE,
    tmpDir,
  }));

  // Write the upload script (runs after claude -p finishes)
  const uploadScript = join(tmpDir, "upload.mjs");
  writeFileSync(uploadScript, `import { readFileSync, existsSync } from "node:fs";
const cfg = JSON.parse(readFileSync("${configFile}", "utf-8"));
function esc(s) { return s.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "''").replace(/[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, ""); }
async function query(sql) {
  const r = await fetch(cfg.apiUrl + "/workspaces/" + cfg.workspaceId + "/tables/query", {
    method: "POST",
    headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json", "X-Activeloop-Org-Id": cfg.orgId },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error("API " + r.status + ": " + (await r.text()).slice(0, 200));
}
async function upload(vpath, localPath) {
  if (!existsSync(localPath)) return;
  const text = readFileSync(localPath, "utf-8");
  if (!text.trim()) return;
  const hex = Buffer.from(text, "utf-8").toString("hex");
  const fname = vpath.split("/").pop();
  await query("DELETE FROM \\"" + cfg.table + "\\" WHERE path = '" + esc(vpath) + "'");
  await query("INSERT INTO \\"" + cfg.table + "\\" (path, filename, content, content_text, mime_type, size_bytes) VALUES ('" + esc(vpath) + "', '" + esc(fname) + "', E'\\\\\\\\x" + hex + "', E'" + esc(text) + "', 'text/markdown', " + Buffer.byteLength(text) + ")");
  console.log("Uploaded " + vpath);
}
await upload("/summaries/" + cfg.sessionId + ".md", cfg.summaryPath);
await upload("/index.md", cfg.indexPath);
console.log("Server upload complete for " + cfg.sessionId);
`);

  // Write the wrapper bash script — same nohup pattern as CLI's deeplake-wiki.sh
  const wrapperScript = join(tmpDir, "wiki-worker.sh");
  writeFileSync(wrapperScript, `#!/bin/bash
LOG="${WIKI_LOG}"
PROMPT_FILE="${promptFile}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki-worker: starting claude -p for ${sessionId}" >> "$LOG"

PROMPT=$(cat "$PROMPT_FILE")
"${claudeBin}" -p "$PROMPT" \\
  --no-session-persistence \\
  --model haiku \\
  --permission-mode bypassPermissions \\
  >> "$LOG" 2>&1

EXIT_CODE=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki-worker: claude -p exited (code $EXIT_CODE) for ${sessionId}" >> "$LOG"

# Copy to local disk
mkdir -p "${SUMMARIES_DIR}"
[ -f "${tmpSummary}" ] && cp "${tmpSummary}" "${join(SUMMARIES_DIR, `${sessionId}.md`)}"
[ -f "${tmpIndex}" ] && cp "${tmpIndex}" "${INDEX_FILE}"

# Upload to server
node "${uploadScript}" >> "$LOG" 2>&1

# Cleanup
rm -rf "${tmpDir}"
`, { mode: 0o755 });

  // Spawn in background with nohup — same as CLI's deeplake-wiki.sh
  spawn("nohup", ["bash", wrapperScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  wikiLog(`SessionEnd: spawned wiki worker for ${sessionId} (script: ${wrapperScript})`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
