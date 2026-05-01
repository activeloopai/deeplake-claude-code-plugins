// @ts-nocheck — distributed as raw .ts; pi's runtime loads + compiles it.
// We ship this file verbatim into ~/.pi/agent/extensions/hivemind.ts.
//
// Hivemind extension for pi (badlogic/pi-mono coding-agent).
//
// Subscribes to the agent lifecycle events documented in
// `pi-mono/packages/coding-agent/src/core/extensions/types.ts` to:
//   - inject deeplake memory context at session_start
//   - capture user prompts (input event)
//   - capture tool call results (tool_result event)
//   - capture assistant messages (message_end event)
//   - finalize on session_shutdown
//
// Plus registers three first-class pi tools (since pi has no MCP):
//   - hivemind_search
//   - hivemind_read
//   - hivemind_index
//
// All deeplake interactions are inline `fetch` calls so this file has
// zero non-builtin runtime dependencies — it only needs Node 22+ globals.
//
// Type imports are erased at runtime so they don't need to be installed
// at our build time. pi's `@mariozechner/pi-coding-agent` types are
// available to pi's compiler when this is loaded.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync,
  openSync, closeSync, constants as fsConstants,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect } from "node:net";
import { spawn, execSync } from "node:child_process";

// ---------- diagnostic logging --------------------------------------------------
//
// The capture path is fully async + swallows errors (writeSessionRow's catch
// is intentionally non-fatal, so a transient deeplake outage never breaks pi).
// That means a buggy extension is silent: rows just don't appear, with no
// indication where things went wrong. When HIVEMIND_DEBUG=1 we dump a
// breadcrumb to ~/.deeplake/hivemind-pi.log at every meaningful step so the
// failure mode is observable. Off by default to keep `pi` quiet for normal
// users.

const LOG_PATH = join(homedir(), ".deeplake", "hivemind-pi.log");

function logHm(msg: string): void {
  if (process.env.HIVEMIND_DEBUG !== "1") return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [pi] ${msg}\n`);
  } catch { /* logging must never break the agent */ }
}

// ---------- credentials / config -----------------------------------------------

interface Creds {
  token: string;
  apiUrl: string;
  orgId: string;
  orgName?: string;
  workspaceId: string;
  userName: string;
}

function loadCreds(): Creds | null {
  const path = join(homedir(), ".deeplake", "credentials.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed?.token) return null;
    return {
      token: parsed.token,
      apiUrl: parsed.apiUrl ?? "https://api.deeplake.ai",
      orgId: parsed.orgId,
      orgName: parsed.orgName,
      workspaceId: parsed.workspaceId ?? "default",
      userName: parsed.userName ?? "unknown",
    };
  } catch {
    return null;
  }
}

const MEMORY_TABLE = process.env.HIVEMIND_TABLE ?? "memory";
const SESSIONS_TABLE = process.env.HIVEMIND_SESSIONS_TABLE ?? "sessions";

// ---------- SQL escape (matches src/utils/sql.ts) ------------------------------

function sqlStr(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// LIKE-pattern escape: sqlStr only handles SQL string quoting, NOT LIKE
// metacharacters. Without this, a tool arg containing `%` or `_` (which
// the LLM controls via the tool schema) would bypass the intended path
// filter — e.g. prefix='%' would match every row in the table. Wrap the
// resulting LIKE clause with `ESCAPE '\\'` so the engine honours the
// backslash escaping below.
function sqlLike(value: string): string {
  return sqlStr(value)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

// JSONB column escape — only single-quote doubling, preserves JSON escape sequences.
function sqlJsonb(json: string): string {
  return json.replace(/'/g, "''");
}

// ---------- deeplake api -------------------------------------------------------

async function dlQuery(creds: Creds, sql: string): Promise<unknown[]> {
  const resp = await fetch(`${creds.apiUrl}/workspaces/${creds.workspaceId}/tables/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "X-Activeloop-Org-Id": creds.orgId,
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`deeplake query failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { columns?: string[]; rows?: unknown[][] };
  if (!json.rows || !json.columns) return [];
  return json.rows.map((r) => Object.fromEntries(json.columns!.map((c, i) => [c, r[i]])));
}

// ---------- embedding client (inline; reuses the shared daemon) ----------------
//
// Pi avoids importing EmbedClient (which is bundled into other agents but
// here would break the "raw .ts, zero deps" promise of pi extensions).
// Instead we open a Unix socket directly to the daemon at the same well-known
// path EmbedClient uses. If the socket isn't there yet, we spawn the
// canonical daemon at ~/.hivemind/embed-deps/embed-daemon.js (deposited by
// `hivemind embeddings install`) and wait for it to listen, mirroring the
// auto-spawn-on-miss logic in src/embeddings/client.ts. Subsequent agents
// (codex, CC, cursor, hermes, …) connect to the SAME daemon — pi pays the
// cold-start cost only when it's the first user on the box.
//
// Graceful fallback: any failure → return null → caller writes NULL into
// message_embedding. Embedding is never on the critical path.

const EMBED_DAEMON_ENTRY = join(homedir(), ".hivemind", "embed-deps", "embed-daemon.js");
const EMBED_SOCKET_PATH = (() => {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : (process.env.USER ?? "default");
  return `/tmp/hivemind-embed-${uid}.sock`;
})();

function tryEmbedOverSocket(text: string, kind: "document" | "query"): Promise<number[] | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (v: number[] | null) => { if (!resolved) { resolved = true; resolve(v); } };
    const sock = connect(EMBED_SOCKET_PATH);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); settle(null); }, 5000);
    sock.on("connect", () => {
      // Protocol shape comes from src/embeddings/protocol.ts: {op, id, kind, text}.
      // id is a string ("1"), not a number, and the verb field is "op" not "type".
      sock.write(JSON.stringify({ op: "embed", id: "1", kind, text }) + "\n");
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          settle(Array.isArray(resp.embedding) ? resp.embedding : null);
        } catch { settle(null); }
        sock.destroy();
      }
    });
    sock.on("error", () => { clearTimeout(timer); settle(null); });
    sock.on("close", () => { clearTimeout(timer); settle(null); });
  });
}

// ---------- summary state + wiki-worker spawn ---------------------------------
//
// Mirror of src/hooks/summary-state.ts (same dir, same JSON shape, shared
// across CC/codex/cursor/hermes — session ids are UUIDs so collisions are
// impossible). The pi extension increments totalCount on every captured
// event and spawns the bundled wiki-worker (see pi/bundle/wiki-worker.js)
// when the threshold is hit. The worker, after generating the summary,
// calls finalizeSummary() / releaseLock() against this same dir. So the
// extension and the worker share state.

const SUMMARY_STATE_DIR = join(homedir(), ".claude", "hooks", "summary-state");
const PI_WIKI_WORKER_PATH = join(homedir(), ".pi", "agent", "hivemind", "wiki-worker.js");

interface SummaryState {
  lastSummaryAt: number;
  lastSummaryCount: number;
  totalCount: number;
}
interface SummaryConfig {
  everyNMessages: number;
  everyHours: number;
}

function summaryStatePath(sessionId: string): string {
  return join(SUMMARY_STATE_DIR, `${sessionId}.json`);
}
function summaryLockPath(sessionId: string): string {
  return join(SUMMARY_STATE_DIR, `${sessionId}.lock`);
}

function loadSummaryConfig(): SummaryConfig {
  const n = Number(process.env.HIVEMIND_SUMMARY_EVERY_N_MSGS ?? "");
  const h = Number(process.env.HIVEMIND_SUMMARY_EVERY_HOURS ?? "");
  return {
    everyNMessages: Number.isInteger(n) && n > 0 ? n : 50,
    everyHours: Number.isFinite(h) && h > 0 ? h : 2,
  };
}

// Mirrors src/hooks/summary-state.ts — the very first summary fires at
// totalCount=10 (vs the steady-state N=50) so a fresh chat gets indexed
// quickly without waiting for ~50 messages.
const FIRST_SUMMARY_AT = 10;

function readSummaryState(sessionId: string): SummaryState | null {
  try {
    const p = summaryStatePath(sessionId);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return {
      lastSummaryAt: Number(raw.lastSummaryAt) || 0,
      lastSummaryCount: Number(raw.lastSummaryCount) || 0,
      totalCount: Number(raw.totalCount) || 0,
    };
  } catch { return null; }
}

function writeSummaryState(sessionId: string, state: SummaryState): void {
  try {
    mkdirSync(SUMMARY_STATE_DIR, { recursive: true });
    writeFileSync(summaryStatePath(sessionId), JSON.stringify(state));
  } catch { /* non-fatal */ }
}

function bumpCounter(sessionId: string): SummaryState {
  const cur = readSummaryState(sessionId) ?? { lastSummaryAt: 0, lastSummaryCount: 0, totalCount: 0 };
  cur.totalCount += 1;
  writeSummaryState(sessionId, cur);
  return cur;
}

function shouldTriggerNow(state: SummaryState, cfg: SummaryConfig): boolean {
  const msgsSince = state.totalCount - state.lastSummaryCount;
  // First-chat trigger: index a fresh session quickly (10 events) instead of
  // waiting until N=50. Mirrors summary-state.ts in CC/codex.
  if (state.lastSummaryCount === 0 && state.totalCount >= FIRST_SUMMARY_AT) return true;
  if (msgsSince >= cfg.everyNMessages) return true;
  if (msgsSince > 0 && state.lastSummaryAt > 0
      && Date.now() - state.lastSummaryAt >= cfg.everyHours * 3600 * 1000) return true;
  return false;
}

function tryAcquireSummaryLock(sessionId: string): boolean {
  try {
    mkdirSync(SUMMARY_STATE_DIR, { recursive: true });
    const fd = openSync(summaryLockPath(sessionId),
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
    return true;
  } catch { return false; }
}

function findPiBin(): string {
  try {
    const out = execSync("which pi 2>/dev/null", { encoding: "utf-8" }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return "pi";
}

// Same template the CC/codex spawn-wiki-worker.ts ships. Inlined here
// because the pi extension is raw .ts and can't import it.
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

function spawnWikiWorker(
  creds: Creds,
  sessionId: string,
  cwd: string,
  reason: "periodic" | "final",
): void {
  if (!existsSync(PI_WIKI_WORKER_PATH)) {
    logHm(`spawnWikiWorker(${reason}): no worker at ${PI_WIKI_WORKER_PATH} — install via 'hivemind pi install' or rebuild`);
    return;
  }
  // Periodic: only one in-flight; lock prevents races between events.
  // Final: also takes the lock — if a periodic was mid-flight at session_shutdown,
  // skip the final to avoid two concurrent workers writing back to the same row.
  if (!tryAcquireSummaryLock(sessionId)) {
    logHm(`spawnWikiWorker(${reason}): lock held — skipping (a worker is already running)`);
    return;
  }
  // tmp dir owned by the worker; it removes it on completion.
  const tmpDir = join(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  const configPath = join(tmpDir, "config.json");
  const project = (cwd ?? "").split("/").pop() || "unknown";
  const config = {
    apiUrl: creds.apiUrl,
    token: creds.token,
    orgId: creds.orgId,
    workspaceId: creds.workspaceId,
    memoryTable: MEMORY_TABLE,
    sessionsTable: SESSIONS_TABLE,
    sessionId,
    userName: creds.userName,
    project,
    tmpDir,
    piBin: findPiBin(),
    piProvider: process.env.HIVEMIND_PI_PROVIDER ?? "google",
    piModel: process.env.HIVEMIND_PI_MODEL ?? "gemini-2.5-flash",
    wikiLog: join(homedir(), ".deeplake", "hivemind-pi.log"),
    hooksDir: join(homedir(), ".pi", "agent", "hivemind"),
    promptTemplate: WIKI_PROMPT_TEMPLATE,
  };
  try { writeFileSync(configPath, JSON.stringify(config)); }
  catch (e: any) { logHm(`spawnWikiWorker(${reason}): writeFileSync failed: ${e?.message ?? e}`); return; }
  logHm(`spawnWikiWorker(${reason}): spawning ${PI_WIKI_WORKER_PATH} session=${sessionId} provider=${config.piProvider} model=${config.piModel}`);
  try {
    spawn(process.execPath, [PI_WIKI_WORKER_PATH, configPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
    }).unref();
  } catch (e: any) {
    logHm(`spawnWikiWorker(${reason}): spawn failed: ${e?.message ?? e}`);
  }
}

function maybeTriggerPeriodicSummary(creds: Creds, sessionId: string, cwd: string): void {
  if (process.env.HIVEMIND_CAPTURE === "false") return;
  const state = bumpCounter(sessionId);
  const cfg = loadSummaryConfig();
  if (!shouldTriggerNow(state, cfg)) return;
  logHm(`periodic threshold hit (total=${state.totalCount}, since=${state.totalCount - state.lastSummaryCount}, N=${cfg.everyNMessages}, hours=${cfg.everyHours})`);
  spawnWikiWorker(creds, sessionId, cwd, "periodic");
}

async function embed(text: string): Promise<number[] | null> {
  if (process.env.HIVEMIND_EMBEDDINGS === "false") {
    logHm(`embed: skipped (HIVEMIND_EMBEDDINGS=false)`);
    return null;
  }
  if (!text || text.length === 0) {
    logHm(`embed: skipped (empty text)`);
    return null;
  }
  // 1) socket already up (another agent or us in a previous turn) → fast path
  let v = await tryEmbedOverSocket(text, "document");
  if (v !== null) {
    logHm(`embed: ok via existing socket (dims=${v.length})`);
    return v;
  }
  // 2) no daemon binary deposited → fallback NULL
  if (!existsSync(EMBED_DAEMON_ENTRY)) {
    logHm(`embed: no daemon at ${EMBED_DAEMON_ENTRY} — run 'hivemind embeddings install'`);
    return null;
  }
  // 3) spawn the canonical daemon detached; daemon's own pidfile lock guards
  //    against double-spawn if multiple pi turns race.
  logHm(`embed: spawning daemon at ${EMBED_DAEMON_ENTRY}`);
  try {
    spawn(process.execPath, [EMBED_DAEMON_ENTRY], { detached: true, stdio: "ignore" }).unref();
  } catch (e: any) {
    logHm(`embed: spawn failed: ${e?.message ?? e}`);
    return null;
  }
  // 4) poll for the socket up to ~5s, then retry the embed once
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (existsSync(EMBED_SOCKET_PATH)) {
      v = await tryEmbedOverSocket(text, "document");
      if (v !== null) {
        logHm(`embed: ok after spawn (dims=${v.length}, polls=${i + 1})`);
        return v;
      }
    }
  }
  logHm(`embed: timed out after spawn (5s)`);
  return null;
}

function embedSqlLiteral(emb: number[] | null): string {
  if (!emb || emb.length === 0) return "NULL";
  // FLOAT4[] literal. Numbers serialize without quotes; emb is a plain
  // number[] from the daemon so JSON-style join is safe.
  return `ARRAY[${emb.join(",")}]::FLOAT4[]`;
}

// ---------- session-row writer -------------------------------------------------

function buildSessionPath(creds: Creds, sessionId: string): string {
  const filename = `${creds.userName}_${creds.orgName ?? creds.orgId}_${creds.workspaceId}_${sessionId}.jsonl`;
  return `/sessions/${creds.userName}/${filename}`;
}

// Deeplake quirk: CREATE TABLE IF NOT EXISTS returns 200 before the table
// is queryable for INSERTs (the propagation can take 30+ seconds on a fresh
// table). Other agents don't hit this in steady state because they reuse
// existing tables; pi's e2e tests use fresh timestamped tables every run.
// Fix: tolerate "Table does not exist" specifically and retry with backoff.
const INSERT_RETRY_BACKOFFS_MS = [1000, 3000, 8000, 15000];

async function writeSessionRow(
  creds: Creds,
  sessionId: string,
  agent: string,
  event: string,
  cwd: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString();
  const sessionPath = buildSessionPath(creds, sessionId);
  const filename = sessionPath.split("/").pop() ?? "";
  const projectName = (cwd ?? "").split("/").pop() || "unknown";
  const line = JSON.stringify(entry);
  const jsonForSql = sqlJsonb(line);
  logHm(`writeSessionRow: event=${event} session=${sessionId} bytes=${line.length} table=${SESSIONS_TABLE}`);
  const emb = await embed(line);
  logHm(`writeSessionRow: embed=${emb ? `dims=${emb.length}` : "null"}`);
  const insertSql =
    `INSERT INTO "${SESSIONS_TABLE}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, ${embedSqlLiteral(emb)}, '${sqlStr(creds.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(event)}', '${agent}', '${ts}', '${ts}')`;
  let lastErr: any = null;
  for (let attempt = 0; attempt <= INSERT_RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      await dlQuery(creds, insertSql);
      logHm(`writeSessionRow: INSERT ok (event=${event}, attempt=${attempt + 1})`);
      return;
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message ?? String(e);
      const isPropagationDelay = /table does not exist|relation .* does not exist/i.test(msg);
      if (!isPropagationDelay || attempt === INSERT_RETRY_BACKOFFS_MS.length) {
        logHm(`writeSessionRow: INSERT FAILED (event=${event}, attempt=${attempt + 1}): ${msg}`);
        throw e;
      }
      const delay = INSERT_RETRY_BACKOFFS_MS[attempt];
      logHm(`writeSessionRow: table not yet visible, retrying in ${delay}ms (attempt=${attempt + 1}/${INSERT_RETRY_BACKOFFS_MS.length + 1})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------- search primitive (used by hivemind_search) -------------------------

async function searchTables(creds: Creds, query: string, limit: number): Promise<string> {
  // ILIKE pattern: escape both SQL quotes AND LIKE wildcards. ESCAPE '\\'
  // tells the engine to treat backslash as the escape character so our
  // \% / \_ are matched literally instead of as wildcards.
  const pattern = sqlLike(query);
  const memQuery = `SELECT path, summary::text AS content, 0 AS source_order FROM "${MEMORY_TABLE}" WHERE summary::text ILIKE '%${pattern}%' ESCAPE '\\' LIMIT ${limit}`;
  const sessQuery = `SELECT path, message::text AS content, 1 AS source_order FROM "${SESSIONS_TABLE}" WHERE message::text ILIKE '%${pattern}%' ESCAPE '\\' LIMIT ${limit}`;
  const sql = `SELECT path, content, source_order FROM ((${memQuery}) UNION ALL (${sessQuery})) AS combined ORDER BY path, source_order LIMIT ${limit}`;
  const rows = await dlQuery(creds, sql);
  if (rows.length === 0) return `No matches for "${query}".`;
  return rows
    .map((r: any) => `[${r.path}]\n${String(r.content ?? "").slice(0, 600)}`)
    .join("\n\n---\n\n");
}

// pi tools must return AgentToolResult: { content: [{type:"text", text}], details }.
// Returning a raw string crashes pi's renderer (render-utils.js: result.content.filter).
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ---------- main extension -----------------------------------------------------

const CONTEXT_PREAMBLE = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents in your org.

Three hivemind tools are registered:
  hivemind_search { query, limit? }   keyword search across summaries + sessions
  hivemind_read   { path }            read full content at a memory path
  hivemind_index  { prefix?, limit? } list summary entries

Prefer these tools — one call returns ranked hits across all summaries and sessions in a single SQL query. Different paths under /summaries/<username>/ are different users; do NOT merge or alias them. Fall back to grep on ~/.deeplake/memory/ only if tools are unavailable.`;

export default function hivemindExtension(pi: ExtensionAPI): void {
  const captureEnabled = process.env.HIVEMIND_CAPTURE !== "false";

  // --- Tools (read path) -------------------------------------------------------

  pi.registerTool({
    name: "hivemind_search",
    description: "Search Hivemind shared memory (summaries + raw sessions) by keyword. Use this first when the user asks about prior work or context that may exist in Hivemind. Different paths under /summaries/<username>/ are different users — do NOT merge them.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or substring to search for." },
        limit: { type: "number", description: "Max hits (default 10)." },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      const creds = loadCreds();
      if (!creds) return textResult("Hivemind: not authenticated. Run `hivemind login` in a terminal.");
      try {
        return textResult(await searchTables(creds, params.query, params.limit ?? 10));
      } catch (err: any) {
        return textResult(`Hivemind search failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "hivemind_read",
    description: "Read the full content at a Hivemind memory path (e.g. /summaries/alice/abc.md or /sessions/alice/...jsonl). Use after hivemind_search to drill into a hit.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute Hivemind memory path." } },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string }) {
      const creds = loadCreds();
      if (!creds) return textResult("Hivemind: not authenticated.");
      const path = params.path;
      const isSession = path.startsWith("/sessions/");
      const table = isSession ? SESSIONS_TABLE : MEMORY_TABLE;
      const col = isSession ? "message::text" : "summary::text";
      const sql = `SELECT path, ${col} AS content FROM "${table}" WHERE path = '${sqlStr(path)}' LIMIT 200`;
      try {
        const rows = await dlQuery(creds, sql);
        if (rows.length === 0) return textResult(`No content at ${path}.`);
        return textResult(rows.map((r: any) => String(r.content ?? "")).join("\n"));
      } catch (err: any) {
        return textResult(`Hivemind read failed: ${err.message}`);
      }
    },
  });

  pi.registerTool({
    name: "hivemind_index",
    description: "List Hivemind summary entries (one row per session). Use to see what's in shared memory.",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Path prefix, e.g. '/summaries/alice/'." },
        limit: { type: "number", description: "Max rows (default 50)." },
      },
    },
    async execute(_toolCallId: string, params: { prefix?: string; limit?: number }) {
      const creds = loadCreds();
      if (!creds) return textResult("Hivemind: not authenticated.");
      const where = params.prefix
        ? `WHERE path LIKE '${sqlLike(params.prefix)}%' ESCAPE '\\'`
        : `WHERE path LIKE '/summaries/%'`;
      const sql = `SELECT path, description, project, last_update_date FROM "${MEMORY_TABLE}" ${where} ORDER BY last_update_date DESC LIMIT ${params.limit ?? 50}`;
      try {
        const rows = await dlQuery(creds, sql);
        if (rows.length === 0) return textResult("No summaries.");
        return textResult(rows
          .map((r: any) => `${r.path}\t${r.last_update_date}\t${r.project ?? ""}\t${r.description ?? ""}`)
          .join("\n"));
      } catch (err: any) {
        return textResult(`Hivemind index failed: ${err.message}`);
      }
    },
  });

  // --- Lifecycle hooks (capture path) -----------------------------------------
  //
  // Event shapes per pi-coding-agent/dist/core/extensions/types.d.ts:
  //   - SessionStartEvent:  { type, reason, previousSessionFile? }
  //   - InputEvent:         { type, text, images?, source }
  //   - ToolResultEvent:    { type, toolCallId, toolName, input, content, isError, details }
  //   - MessageEndEvent:    { type, message: AgentMessage }
  // Every handler receives (event, ctx). ctx.sessionManager.getSessionId() and
  // ctx.cwd are the canonical sources for session id + cwd — the events
  // themselves don't carry them.

  pi.on("session_start", async (_event: any, _ctx: any) => {
    logHm(`session_start: fired (capture=${captureEnabled}, embed=${process.env.HIVEMIND_EMBEDDINGS !== "false"}, table=${SESSIONS_TABLE})`);
    const creds = loadCreds();
    if (!creds) {
      logHm(`session_start: no credentials at ~/.deeplake/credentials.json — capture disabled this session`);
    } else {
      logHm(`session_start: creds org=${creds.orgName ?? creds.orgId} ws=${creds.workspaceId}`);
    }
    if (creds && captureEnabled) {
      // Other agents' session-start hooks create the memory + sessions tables
      // via DeeplakeApi.ensureTable / ensureSessionsTable. The pi extension is
      // standalone (no shared lib import to keep it raw-.ts), so we issue the
      // CREATE TABLE IF NOT EXISTS directly. Schema matches the canonical one
      // in src/deeplake-api.ts so all agents read/write the same shape.
      const memCreate = `CREATE TABLE IF NOT EXISTS "${MEMORY_TABLE}" (` +
        `id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', ` +
        `filename TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', ` +
        `summary_embedding FLOAT4[], author TEXT NOT NULL DEFAULT '', ` +
        `mime_type TEXT NOT NULL DEFAULT 'text/plain', size_bytes BIGINT NOT NULL DEFAULT 0, ` +
        `project TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', ` +
        `agent TEXT NOT NULL DEFAULT '', creation_date TEXT NOT NULL DEFAULT '', ` +
        `last_update_date TEXT NOT NULL DEFAULT ''` +
        `) USING deeplake`;
      const sessCreate = `CREATE TABLE IF NOT EXISTS "${SESSIONS_TABLE}" (` +
        `id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', ` +
        `filename TEXT NOT NULL DEFAULT '', message JSONB, message_embedding FLOAT4[], ` +
        `author TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/json', ` +
        `size_bytes BIGINT NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', ` +
        `description TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', ` +
        `creation_date TEXT NOT NULL DEFAULT '', last_update_date TEXT NOT NULL DEFAULT ''` +
        `) USING deeplake`;
      try { await dlQuery(creds, memCreate); logHm(`session_start: memory CREATE TABLE ok (${MEMORY_TABLE})`); }
      catch (e: any) { logHm(`session_start: memory CREATE failed: ${e?.message ?? e}`); }
      try { await dlQuery(creds, sessCreate); logHm(`session_start: sessions CREATE TABLE ok (${SESSIONS_TABLE})`); }
      catch (e: any) { logHm(`session_start: sessions CREATE failed: ${e?.message ?? e}`); }
      // Proactively poll until the sessions table is queryable. CREATE TABLE
      // returns 200 before propagation completes on Deeplake; the first INSERT
      // can otherwise fail with "Table does not exist" for ~30s. Polling here
      // amortises the delay before any event fires.
      const probeSql = `SELECT 1 FROM "${SESSIONS_TABLE}" LIMIT 1`;
      const start = Date.now();
      let visible = false;
      for (let i = 0; i < 30 && !visible; i++) {
        try {
          await dlQuery(creds, probeSql);
          visible = true;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (!/table does not exist|relation .* does not exist/i.test(msg)) {
            logHm(`session_start: probe failed (non-propagation): ${msg}`);
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      logHm(`session_start: sessions table visible=${visible} (probe took ${Date.now() - start}ms)`);
    }
    const additional = creds
      ? `${CONTEXT_PREAMBLE}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId}).`
      : `${CONTEXT_PREAMBLE}\nNot logged in to Deeplake. Run \`hivemind login\` to authenticate.`;
    return { additionalContext: additional };
  });

  pi.on("input", async (event: any, ctx: any) => {
    logHm(`input: fired source=${event?.source ?? "?"}`);
    if (!captureEnabled) { logHm(`input: capture disabled, skipping`); return; }
    if (event.source === "extension") { logHm(`input: extension-injected, skipping`); return; }
    const creds = loadCreds();
    if (!creds) { logHm(`input: no creds, skipping`); return; }
    const text = typeof event.text === "string" ? event.text : "";
    if (!text) { logHm(`input: empty text, skipping`); return; }
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? `pi-${Date.now()}`;
    const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    try {
      await writeSessionRow(creds, sessionId, "pi", "input", cwd, {
        id: crypto.randomUUID(),
        type: "user_message",
        session_id: sessionId,
        content: text,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      logHm(`input: writeSessionRow swallowed: ${e?.message ?? e}`);
    }
    maybeTriggerPeriodicSummary(creds, sessionId, cwd);
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    logHm(`tool_result: fired tool=${event?.toolName ?? "?"} isError=${event?.isError === true}`);
    if (!captureEnabled) { logHm(`tool_result: capture disabled, skipping`); return; }
    const creds = loadCreds();
    if (!creds) { logHm(`tool_result: no creds, skipping`); return; }
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? `pi-${Date.now()}`;
    const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    // event.content is (TextContent | ImageContent)[]; extract text blocks.
    const contentBlocks: any[] = Array.isArray(event.content) ? event.content : [];
    const responseText = contentBlocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    try {
      await writeSessionRow(creds, sessionId, "pi", "tool_result", cwd, {
        id: crypto.randomUUID(),
        type: "tool_call",
        session_id: sessionId,
        tool_call_id: event.toolCallId ?? null,
        tool_name: event.toolName ?? "unknown",
        tool_input: JSON.stringify(event.input ?? {}),
        tool_response: responseText || JSON.stringify(contentBlocks),
        is_error: event.isError === true,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      logHm(`tool_result: writeSessionRow swallowed: ${e?.message ?? e}`);
    }
    maybeTriggerPeriodicSummary(creds, sessionId, cwd);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    logHm(`message_end: fired role=${event?.message?.role ?? "?"}`);
    if (!captureEnabled) { logHm(`message_end: capture disabled, skipping`); return; }
    const creds = loadCreds();
    if (!creds) { logHm(`message_end: no creds, skipping`); return; }
    const message = event.message ?? null;
    // AgentMessage is UserMessage | AssistantMessage | ToolResultMessage.
    // user is captured via `input`; toolResult via `tool_result`. Only assistant here.
    if (!message || message.role !== "assistant") {
      logHm(`message_end: skipping (role=${message?.role ?? "null"} — only assistant rows are written here)`);
      return;
    }
    // AssistantMessage.content is (TextContent | ThinkingContent | ToolCall)[].
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    if (!text) { logHm(`message_end: assistant message had no text blocks, skipping`); return; }
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? `pi-${Date.now()}`;
    const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    try {
      await writeSessionRow(creds, sessionId, "pi", "message_end", cwd, {
        id: crypto.randomUUID(),
        type: "assistant_message",
        session_id: sessionId,
        content: text,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      logHm(`message_end: writeSessionRow swallowed: ${e?.message ?? e}`);
    }
    maybeTriggerPeriodicSummary(creds, sessionId, cwd);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    logHm(`session_shutdown: fired`);
    if (process.env.HIVEMIND_CAPTURE === "false") return;
    const creds = loadCreds();
    if (!creds) { logHm(`session_shutdown: no creds, skipping final summary`); return; }
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
    if (!sessionId) { logHm(`session_shutdown: no sessionId, skipping final summary`); return; }
    const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    // Always spawn for "final" — but the lock check inside spawnWikiWorker
    // skips if a periodic worker is mid-flight. Non-fatal either way.
    spawnWikiWorker(creds, sessionId, cwd, "final");
  });

  // Module-load breadcrumb so we know the extension's default export ran at all.
  logHm(`extension loaded (table=${SESSIONS_TABLE}, mem=${MEMORY_TABLE})`);
}
