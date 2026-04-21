#!/usr/bin/env node

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve2, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve2(JSON.parse(data));
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
  const env = process.env;
  if (!env.HIVEMIND_TOKEN && env.DEEPLAKE_TOKEN) {
    process.stderr.write("[hivemind] DEEPLAKE_* env vars are deprecated; use HIVEMIND_* instead\n");
  }
  const token = env.HIVEMIND_TOKEN ?? env.DEEPLAKE_TOKEN ?? creds?.token;
  const orgId = env.HIVEMIND_ORG_ID ?? env.DEEPLAKE_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: env.HIVEMIND_WORKSPACE_ID ?? env.DEEPLAKE_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: env.HIVEMIND_API_URL ?? env.DEEPLAKE_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: env.HIVEMIND_TABLE ?? env.DEEPLAKE_TABLE ?? "memory",
    sessionsTableName: env.HIVEMIND_SESSIONS_TABLE ?? env.DEEPLAKE_SESSIONS_TABLE ?? "sessions",
    graphNodesTableName: env.HIVEMIND_GRAPH_NODES_TABLE ?? env.DEEPLAKE_GRAPH_NODES_TABLE ?? "graph_nodes",
    graphEdgesTableName: env.HIVEMIND_GRAPH_EDGES_TABLE ?? env.DEEPLAKE_GRAPH_EDGES_TABLE ?? "graph_edges",
    factsTableName: env.HIVEMIND_FACTS_TABLE ?? env.DEEPLAKE_FACTS_TABLE ?? "memory_facts",
    entitiesTableName: env.HIVEMIND_ENTITIES_TABLE ?? env.DEEPLAKE_ENTITIES_TABLE ?? "memory_entities",
    factEntityLinksTableName: env.HIVEMIND_FACT_ENTITY_LINKS_TABLE ?? env.DEEPLAKE_FACT_ENTITY_LINKS_TABLE ?? "fact_entity_links",
    memoryPath: env.HIVEMIND_MEMORY_PATH ?? env.DEEPLAKE_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/utils/direct-run.js
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch {
    return false;
  }
}

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync2, writeFileSync, writeSync, mkdirSync, renameSync, existsSync as existsSync2, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var dlog = (msg) => log("summary-state", msg);
var STATE_DIR = join3(homedir3(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join3(STATE_DIR, `${sessionId}.json`);
}
function lockPath(sessionId) {
  return join3(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync2(p))
    return null;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(rmwLock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog(`rmw lock deadline exceeded for ${sessionId}, reclaiming stale lock`);
        try {
          unlinkSync(rmwLock);
        } catch (unlinkErr) {
          dlog(`stale rmw lock unlink failed for ${sessionId}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(rmwLock);
    } catch (unlinkErr) {
      dlog(`rmw lock cleanup failed for ${sessionId}: ${unlinkErr.message}`);
    }
  }
}
function bumpTotalCount(sessionId) {
  return withRmwLock(sessionId, () => {
    const now = Date.now();
    const existing = readState(sessionId);
    const next = existing ? { ...existing, totalCount: existing.totalCount + 1 } : { lastSummaryAt: now, lastSummaryCount: 0, totalCount: 1 };
    writeState(sessionId, next);
    return next;
  });
}
function loadTriggerConfig() {
  const n = Number(process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS ?? "");
  const h = Number(process.env.HIVEMIND_SUMMARY_EVERY_HOURS ?? "");
  return {
    everyNMessages: Number.isInteger(n) && n > 0 ? n : 50,
    everyHours: Number.isFinite(h) && h > 0 ? h : 2
  };
}
var FIRST_SUMMARY_AT = 10;
function shouldTrigger(state, cfg, now = Date.now()) {
  const msgsSince = state.totalCount - state.lastSummaryCount;
  if (state.lastSummaryCount === 0 && state.totalCount >= FIRST_SUMMARY_AT)
    return true;
  if (msgsSince >= cfg.everyNMessages)
    return true;
  if (msgsSince > 0 && now - state.lastSummaryAt >= cfg.everyHours * 3600 * 1e3)
    return true;
  return false;
}
function tryAcquireLock(sessionId, maxAgeMs = 10 * 60 * 1e3) {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync2(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync2(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog(`lock file unreadable for ${sessionId}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync(p);
    } catch (unlinkErr) {
      dlog(`could not unlink stale lock for ${sessionId}: ${unlinkErr.message}`);
      return false;
    }
  }
  try {
    const fd = openSync(p, "wx");
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e.code === "EEXIST")
      return false;
    throw e;
  }
}

// dist/src/hooks/codex/spawn-wiki-worker.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname, join as join4 } from "node:path";
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, appendFileSync as appendFileSync2 } from "node:fs";
import { homedir as homedir4, tmpdir } from "node:os";

// dist/src/hooks/knowledge-graph.js
import { randomUUID as randomUUID2 } from "node:crypto";

// dist/src/hooks/upload-summary.js
import { randomUUID } from "node:crypto";

// dist/src/hooks/knowledge-graph.js
var GRAPH_PROMPT_TEMPLATE = `You are extracting a compact knowledge graph delta from a session summary.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

SUMMARY MARKDOWN:
__SUMMARY_TEXT__

Return ONLY valid JSON with this exact shape:
{"nodes":[{"name":"canonical entity name","type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","summary":"short factual description","aliases":["optional alias"]}],"edges":[{"source":"canonical source entity","target":"canonical target entity","relation":"snake_case_relation","summary":"short factual relation summary","evidence":"short supporting phrase"}]}

Rules:
- Use canonical names for repeated entities.
- Include people, places, organizations, books/media, tools, files, goals, status labels, preferences, and notable events when they matter for future recall.
- Convert relationship/status/origin/preferences into edges when possible. Example relation shapes: home_country, relationship_status, enjoys, decided_to_pursue, works_on, uses_tool, located_in, recommended, plans, supports.
- Keep summaries short and factual. Do not invent facts beyond the summary.
- If a source or target appears in an edge but not in nodes, also include it in nodes.
- Prefer stable canonical names over pronouns.
- Return no markdown, no prose, no code fences, only JSON.`;

// dist/src/hooks/memory-facts.js
import { randomUUID as randomUUID3 } from "node:crypto";
var MEMORY_FACT_PROMPT_TEMPLATE = `You are extracting durable long-term memory facts from raw session transcript rows.

SESSION ID: __SESSION_ID__
SOURCE PATH: __SOURCE_PATH__
PROJECT: __PROJECT__

TRANSCRIPT ROWS:
__TRANSCRIPT_TEXT__

Return ONLY valid JSON with this exact shape:
{"facts":[{"subject":"canonical entity","subject_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","subject_aliases":["optional alias"],"predicate":"snake_case_relation","object":"canonical object text","object_type":"person|organization|place|artifact|project|tool|file|event|goal|status|preference|concept|other","object_aliases":["optional alias"],"summary":"short factual claim","evidence":"short supporting phrase","confidence":0.0,"valid_at":"optional date/time text","valid_from":"optional date/time text","valid_to":"optional date/time text"}]}

Rules:
- The transcript rows are the only source of truth for this extraction. Do not rely on summaries or inferred rewrites.
- Extract atomic facts that are useful for later recall. One durable claim per fact.
- Prefer canonical names for repeated people, organizations, places, projects, tools, and artifacts.
- Use relation-style predicates such as works_on, home_country, relationship_status, prefers, plans, decided_to_pursue, located_in, uses_tool, recommended, supports, owns, read, attends, moved_from, moved_to.
- Facts should preserve temporal history instead of overwriting it. If the transcript says something changed, emit the new fact and include timing in valid_at / valid_from / valid_to when the transcript supports it.
- Include assistant-confirmed or tool-confirmed actions when they are stated as completed facts in the transcript.
- If a speaker explicitly self-identifies or states a status, preserve that exact label instead of broadening it.
- Preserve exact named places, titles, organizations, and relative time phrases when they are the stated fact.
- Do not invent facts that are not supported by the transcript.
- Avoid duplicates or near-duplicates. If two facts say the same thing, keep the more specific one.
- Return no markdown, no prose, no code fences, only JSON.`;

// dist/src/hooks/codex/spawn-wiki-worker.js
var HOME = homedir4();
var WIKI_LOG = join4(HOME, ".codex", "hooks", "deeplake-wiki.log");
var WIKI_PROMPT_TEMPLATE = `You are maintaining a persistent wiki from a session transcript. This page will become part of a long-lived knowledge base that future agents will search through index.md before opening the source session. Write for retrieval, not storytelling.

The session may be a coding session, a meeting, or a personal conversation. Your job is to turn the raw transcript into a dense, factual wiki page that preserves names, dates, relationships, preferences, plans, titles, and exact status changes.

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
   - Treat the JSONL as the source of truth. Do not invent facts.

2. Write the summary file at the path above with this EXACT format:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Date**: <primary real-world date/time for the session if the transcript contains one; otherwise "unknown">
- **Participants**: <comma-separated names or roles of the main participants>
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **Topics**: <comma-separated topics, themes, or workstreams>
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-4 dense sentences. What happened, why it mattered, and what changed. Prefer specific names/titles/dates over abstractions.>

## Searchable Facts
<Bullet list of atomic facts. One fact per bullet. Each bullet should be able to answer a future query on its own.
Include exact names, titles, identity labels, relationship status clues, home countries/origins, occupations, preferences, collections, books/media titles, pets, family details, goals, plans, locations, organizations, bugs, APIs, dates, and relative-time resolutions when the session date makes them unambiguous.>

## People
<For each person mentioned: name, role/relationship, notable traits/preferences/goals, and what they did or said. Format: **Name** \u2014 role/relationship \u2014 facts>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs, places, organizations, events, books, songs, artworks, pets, or products.
Format: **entity** (type) \u2014 why it matters, relevant state/details>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W". If no explicit decision happened, say "- None explicit.">

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed. If none, say "- None.">

## Open Questions / TODO
<Anything unresolved, blocked, explicitly deferred, or worth following up later. If none, say "- None explicit.">

IMPORTANT:
- Be exhaustive. If a detail exists in the session and could answer a later question, it should be in the wiki.
- Favor exact nouns and titles over generic paraphrases. Preserve exact book names, organization names, file names, feature names, and self-descriptions.
- Keep facts canonical and query-friendly: "Ava is single", "Leo's home country is Brazil", "The team chose retries because the API returned 429s".
- Resolve relative dates like "last year" or "next month" against the session's own date when the source makes that possible. If it is ambiguous, keep the relative phrase instead of guessing.
- Do not omit beneficiary groups or targets of goals.
PRIVACY: Never include absolute filesystem paths in the summary.
LENGTH LIMIT: Keep the total summary under 4000 characters.`;
function wikiLog(msg) {
  try {
    mkdirSync2(join4(HOME, ".codex", "hooks"), { recursive: true });
    appendFileSync2(WIKI_LOG, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] ${msg}
`);
  } catch {
  }
}
function findCodexBin() {
  try {
    return execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "codex";
  }
}
function spawnCodexWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join4(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync2(tmpDir, { recursive: true });
  const configFile = join4(tmpDir, "config.json");
  writeFileSync2(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable: config.tableName,
    sessionsTable: config.sessionsTableName,
    graphNodesTable: config.graphNodesTableName,
    graphEdgesTable: config.graphEdgesTableName,
    factsTable: config.factsTableName,
    entitiesTable: config.entitiesTableName,
    factEntityLinksTable: config.factEntityLinksTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    tmpDir,
    codexBin: findCodexBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join4(HOME, ".codex", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
    graphPromptTemplate: GRAPH_PROMPT_TEMPLATE,
    factPromptTemplate: MEMORY_FACT_PROMPT_TEMPLATE
  }));
  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);
  const workerPath = join4(bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}
function bundleDirFromImportMeta(importMetaUrl) {
  return dirname(fileURLToPath2(importMetaUrl));
}

// dist/src/hooks/session-queue.js
import { appendFileSync as appendFileSync3, closeSync as closeSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, openSync as openSync2, readFileSync as readFileSync3, readdirSync, renameSync as renameSync2, rmSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
import { homedir as homedir5 } from "node:os";
var DEFAULT_QUEUE_DIR = join5(homedir5(), ".deeplake", "queue");
var DEFAULT_AUTH_FAILURE_TTL_MS = 5 * 6e4;
function buildSessionPath(config, sessionId) {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}
function buildQueuedSessionRow(args) {
  const structured = extractStructuredSessionFields(args.line, args.sessionId);
  return {
    id: crypto.randomUUID(),
    path: args.sessionPath,
    filename: args.sessionPath.split("/").pop() ?? "",
    message: args.line,
    sessionId: structured.sessionId,
    eventType: structured.eventType,
    turnIndex: structured.turnIndex,
    diaId: structured.diaId,
    speaker: structured.speaker,
    text: structured.text,
    turnSummary: structured.turnSummary,
    sourceDateTime: structured.sourceDateTime,
    author: args.userName,
    sizeBytes: Buffer.byteLength(args.line, "utf-8"),
    project: args.projectName,
    description: args.description,
    agent: args.agent,
    creationDate: args.timestamp,
    lastUpdateDate: args.timestamp
  };
}
function appendQueuedSessionRow(row, queueDir = DEFAULT_QUEUE_DIR) {
  mkdirSync3(queueDir, { recursive: true });
  const sessionId = extractSessionId(row.path);
  const queuePath = getQueuePath(queueDir, sessionId);
  appendFileSync3(queuePath, `${JSON.stringify(row)}
`);
  return queuePath;
}
function extractString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function extractNumber(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return 0;
}
function extractStructuredSessionFields(message, fallbackSessionId = "") {
  let parsed = null;
  try {
    const raw = JSON.parse(message);
    if (raw && typeof raw === "object")
      parsed = raw;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      sessionId: fallbackSessionId,
      eventType: "raw_message",
      turnIndex: 0,
      diaId: "",
      speaker: "",
      text: message,
      turnSummary: "",
      sourceDateTime: ""
    };
  }
  const eventType = extractString(parsed["type"]);
  const content = extractString(parsed["content"]);
  const toolName = extractString(parsed["tool_name"]);
  const speaker = extractString(parsed["speaker"]) || (eventType === "user_message" ? "user" : eventType === "assistant_message" ? "assistant" : "");
  const text = extractString(parsed["text"]) || content || (eventType === "tool_call" ? toolName : "");
  return {
    sessionId: extractString(parsed["session_id"]) || fallbackSessionId,
    eventType,
    turnIndex: extractNumber(parsed["turn_index"]),
    diaId: extractString(parsed["dia_id"]),
    speaker,
    text,
    turnSummary: extractString(parsed["summary"]) || extractString(parsed["message_summary"]) || extractString(parsed["msg_summary"]),
    sourceDateTime: extractString(parsed["source_date_time"]) || extractString(parsed["date_time"]) || extractString(parsed["date"])
  };
}
function getQueuePath(queueDir, sessionId) {
  return join5(queueDir, `${sessionId}.jsonl`);
}
function extractSessionId(sessionPath) {
  const filename = sessionPath.split("/").pop() ?? "";
  return filename.replace(/\.jsonl$/, "").split("_").pop() ?? filename;
}

// dist/src/hooks/query-cache.js
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join6 } from "node:path";
import { homedir as homedir6 } from "node:os";
var log2 = (msg) => log("query-cache", msg);
var DEFAULT_CACHE_ROOT = join6(homedir6(), ".deeplake", "query-cache");
var INDEX_CACHE_TTL_MS = 15 * 60 * 1e3;
function getSessionQueryCacheDir(sessionId, deps = {}) {
  const { cacheRoot = DEFAULT_CACHE_ROOT } = deps;
  return join6(cacheRoot, sessionId);
}
function clearSessionQueryCache(sessionId, deps = {}) {
  const { logFn = log2 } = deps;
  try {
    rmSync2(getSessionQueryCacheDir(sessionId, deps), { recursive: true, force: true });
  } catch (e) {
    logFn(`clear failed for session=${sessionId}: ${e.message}`);
  }
}

// dist/src/hooks/codex/capture.js
var log3 = (msg) => log("codex-capture", msg);
var CAPTURE = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";
function buildCodexCaptureEntry(input, timestamp) {
  const meta = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    model: input.model,
    turn_id: input.turn_id,
    timestamp
  };
  if (input.hook_event_name === "UserPromptSubmit" && input.prompt !== void 0) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "user_message",
      content: input.prompt
    };
  }
  if (input.hook_event_name === "PostToolUse" && input.tool_name !== void 0) {
    return {
      id: crypto.randomUUID(),
      ...meta,
      type: "tool_call",
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response)
    };
  }
  return null;
}
function maybeTriggerPeriodicSummary(sessionId, cwd, config, deps = {}) {
  const { bundleDir = bundleDirFromImportMeta(import.meta.url), wikiWorker = process.env.HIVEMIND_WIKI_WORKER === "1", logFn = log3, bumpTotalCountFn = bumpTotalCount, loadTriggerConfigFn = loadTriggerConfig, shouldTriggerFn = shouldTrigger, tryAcquireLockFn = tryAcquireLock, wikiLogFn = wikiLog, spawnCodexWikiWorkerFn = spawnCodexWikiWorker } = deps;
  if (wikiWorker)
    return;
  try {
    const state = bumpTotalCountFn(sessionId);
    const cfg = loadTriggerConfigFn();
    if (!shouldTriggerFn(state, cfg))
      return;
    if (!tryAcquireLockFn(sessionId)) {
      logFn(`periodic trigger suppressed (lock held) session=${sessionId}`);
      return;
    }
    wikiLogFn(`Periodic: threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
    spawnCodexWikiWorkerFn({
      config,
      sessionId,
      cwd,
      bundleDir,
      reason: "Periodic"
    });
  } catch (e) {
    logFn(`periodic trigger error: ${e.message}`);
  }
}
async function runCodexCaptureHook(input, deps = {}) {
  const { captureEnabled = CAPTURE, config = loadConfig(), now = () => (/* @__PURE__ */ new Date()).toISOString(), appendQueuedSessionRowFn = appendQueuedSessionRow, buildQueuedSessionRowFn = buildQueuedSessionRow, clearSessionQueryCacheFn = clearSessionQueryCache, maybeTriggerPeriodicSummaryFn = maybeTriggerPeriodicSummary, logFn = log3 } = deps;
  if (!captureEnabled)
    return { status: "disabled" };
  if (!config) {
    logFn("no config");
    return { status: "no_config" };
  }
  const ts = now();
  const entry = buildCodexCaptureEntry(input, ts);
  if (!entry) {
    logFn(`unknown event: ${input.hook_event_name}, skipping`);
    return { status: "ignored" };
  }
  if (input.hook_event_name === "UserPromptSubmit")
    logFn(`user session=${input.session_id}`);
  else
    logFn(`tool=${input.tool_name} session=${input.session_id}`);
  if (input.hook_event_name === "UserPromptSubmit") {
    clearSessionQueryCacheFn(input.session_id);
  }
  const sessionPath = buildSessionPath(config, input.session_id);
  const line = JSON.stringify(entry);
  const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
  appendQueuedSessionRowFn(buildQueuedSessionRowFn({
    sessionPath,
    line,
    sessionId: input.session_id,
    userName: config.userName,
    projectName,
    description: input.hook_event_name ?? "",
    agent: "codex",
    timestamp: ts
  }));
  logFn(`queued ${input.hook_event_name} for ${sessionPath}`);
  maybeTriggerPeriodicSummaryFn(input.session_id, input.cwd ?? "", config);
  return { status: "queued", entry };
}
async function main() {
  const input = await readStdin();
  await runCodexCaptureHook(input);
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log3(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  buildCodexCaptureEntry,
  maybeTriggerPeriodicSummary,
  runCodexCaptureHook
};
