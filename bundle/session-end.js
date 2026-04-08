#!/usr/bin/env node

// dist/src/hooks/session-end.js
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync as appendFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3, tmpdir } from "node:os";

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

// dist/src/utils/debug.js
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

// dist/src/hooks/session-end.js
var log2 = (msg) => log("session-end", msg);
var HOME = homedir3();
var WIKI_LOG = join3(HOME, ".claude", "hooks", "deeplake-wiki.log");
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
  const workerScript = join3(tmpDir, "wiki-worker.mjs");
  writeFileSync(workerScript, WORKER_SCRIPT);
  spawn("nohup", ["node", workerScript, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`SessionEnd: spawned summary worker for ${sessionId}`);
}
var WORKER_SCRIPT = `
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const tmpDir = cfg.tmpDir;
const tmpJsonl = join(tmpDir, "session.jsonl");
const tmpSummary = join(tmpDir, "summary.md");

function wlog(msg) {
  try {
    mkdirSync(cfg.hooksDir, { recursive: true });
    appendFileSync(cfg.wikiLog, "[" + new Date().toISOString().replace("T", " ").slice(0, 19) + "] wiki-worker(" + cfg.sessionId + "): " + msg + "\\n");
  } catch {}
}

function esc(s) { return s.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "''").replace(/[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, ""); }

async function query(sql, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(cfg.apiUrl + "/workspaces/" + cfg.workspaceId + "/tables/query", {
      method: "POST",
      headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json", "X-Activeloop-Org-Id": cfg.orgId },
      body: JSON.stringify({ query: sql }),
    });
    if (r.ok) {
      return r.json().then(j => {
        if (!j.columns || !j.rows) return [];
        return j.rows.map(row => Object.fromEntries(j.columns.map((col, i) => [col, row[i]])));
      }).catch(() => []);
    }
    if (attempt < retries && (r.status === 502 || r.status === 503 || r.status === 429)) {
      wlog("API " + r.status + ", retrying in " + (attempt + 1) + "s...");
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      continue;
    }
    throw new Error("API " + r.status + ": " + (await r.text()).slice(0, 200));
  }
}

function cleanup() {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

try {
  // 1. Fetch session events from sessions table, reconstruct JSONL
  wlog("fetching session events");
  await query("SELECT deeplake_sync_table('" + cfg.sessionsTable + "')");
  const rows = await query('SELECT content_text, creation_date FROM "' + cfg.sessionsTable + '" WHERE path LIKE \\'' + esc("/sessions/%" + cfg.sessionId + "%") + "\\' ORDER BY creation_date ASC");

  if (rows.length === 0) {
    wlog("no session events found \u2014 exiting");
    cleanup();
    process.exit(0);
  }

  // Reconstruct JSONL from individual rows (content_text is JSONB \u2014 may be object or string)
  const jsonlContent = rows.map(r => typeof r.content_text === "string" ? r.content_text : JSON.stringify(r.content_text)).join("\\n");
  const jsonlLines = rows.length;
  // Derive the server path from the first row's path
  const pathRows = await query('SELECT DISTINCT path FROM "' + cfg.sessionsTable + '" WHERE path LIKE \\'' + esc("/sessions/%" + cfg.sessionId + "%") + "\\' LIMIT 1");
  const jsonlServerPath = pathRows.length > 0 ? pathRows[0].path : "/sessions/unknown/" + cfg.sessionId + ".jsonl";

  writeFileSync(tmpJsonl, jsonlContent);
  wlog("found " + jsonlLines + " events at " + jsonlServerPath);

  // 2. Check for existing summary in memory table (resumed session)
  let prevOffset = 0;
  try {
    await query("SELECT deeplake_sync_table('" + cfg.memoryTable + "')");
    const sumRows = await query('SELECT content_text FROM "' + cfg.memoryTable + '" WHERE path = \\'' + esc("/summaries/" + cfg.userName + "/" + cfg.sessionId + ".md") + "\\' LIMIT 1");
    if (sumRows.length > 0 && sumRows[0]["content_text"]) {
      const existing = sumRows[0]["content_text"];
      const match = existing.match(/\\*\\*JSONL offset\\*\\*:\\s*(\\d+)/);
      if (match) prevOffset = parseInt(match[1], 10);
      writeFileSync(tmpSummary, existing);
      wlog("existing summary found, offset=" + prevOffset);
    }
  } catch {}

  // 3. Build prompt and run claude -p
  const prompt = cfg.promptTemplate
    .replace(/__JSONL__/g, tmpJsonl)
    .replace(/__SUMMARY__/g, tmpSummary)
    .replace(/__SESSION_ID__/g, cfg.sessionId)
    .replace(/__PROJECT__/g, cfg.project)
    .replace(/__PREV_OFFSET__/g, String(prevOffset))
    .replace(/__JSONL_LINES__/g, String(jsonlLines))
    .replace(/__JSONL_SERVER_PATH__/g, jsonlServerPath);

  wlog("running claude -p");
  try {
    execFileSync(cfg.claudeBin, ["-p", prompt, "--no-session-persistence", "--model", "haiku", "--permission-mode", "bypassPermissions"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      env: { ...process.env, DEEPLAKE_WIKI_WORKER: "1", DEEPLAKE_CAPTURE: "false" },
    });
    wlog("claude -p exited (code 0)");
  } catch (e) {
    wlog("claude -p failed: " + (e.status ?? e.message));
  }

  // 4. Upload summary to memory table
  if (existsSync(tmpSummary)) {
    const text = readFileSync(tmpSummary, "utf-8");
    if (text.trim()) {
      const hex = Buffer.from(text, "utf-8").toString("hex");
      const fname = cfg.sessionId + ".md";
      const vpath = "/summaries/" + cfg.userName + "/" + fname;
      const ts = new Date().toISOString();
      await query("SELECT deeplake_sync_table('" + cfg.memoryTable + "')");
      const existing = await query('SELECT path FROM "' + cfg.memoryTable + '" WHERE path = \\'' + esc(vpath) + "\\' LIMIT 1");
      if (existing.length > 0) {
        await query("UPDATE \\"" + cfg.memoryTable + "\\" SET content = E'\\\\\\\\x" + hex + "', content_text = E'" + esc(text) + "', size_bytes = " + Buffer.byteLength(text) + ", last_update_date = '" + ts + "' WHERE path = '" + esc(vpath) + "'");
      } else {
        const id = crypto.randomUUID();
        await query("INSERT INTO \\"" + cfg.memoryTable + "\\" (id, path, filename, content, content_text, mime_type, size_bytes, project, creation_date, last_update_date) VALUES ('" + id + "', '" + esc(vpath) + "', '" + esc(fname) + "', E'\\\\\\\\x" + hex + "', E'" + esc(text) + "', 'text/markdown', " + Buffer.byteLength(text) + ", '" + esc(cfg.project) + "', '" + ts + "', '" + ts + "')");
      }
      wlog("uploaded " + vpath);

      // Update description
      try {
        const whatHappened = text.match(/## What Happened\\n([\\s\\S]*?)(?=\\n##|$)/);
        const desc = whatHappened ? whatHappened[1].trim().slice(0, 300) : "completed";
        await query("UPDATE \\"" + cfg.memoryTable + "\\" SET description = E'" + esc(desc) + "', last_update_date = '" + ts + "' WHERE path = '" + esc(vpath) + "'");
        wlog("updated description");
      } catch (e) { wlog("description update failed: " + e.message); }
    }
  } else {
    wlog("no summary file generated");
  }

  wlog("done");
} catch (e) {
  wlog("fatal: " + e.message);
} finally {
  cleanup();
}
`;
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
