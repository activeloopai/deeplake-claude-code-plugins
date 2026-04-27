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
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// ---------- session-row writer -------------------------------------------------

function buildSessionPath(creds: Creds, sessionId: string): string {
  const filename = `${creds.userName}_${creds.orgName ?? creds.orgId}_${creds.workspaceId}_${sessionId}.jsonl`;
  return `/sessions/${creds.userName}/${filename}`;
}

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
  const insertSql =
    `INSERT INTO "${SESSIONS_TABLE}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(creds.userName)}', ` +
    `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', '${sqlStr(event)}', '${agent}', '${ts}', '${ts}')`;
  await dlQuery(creds, insertSql);
}

// ---------- search primitive (used by hivemind_search) -------------------------

async function searchTables(creds: Creds, query: string, limit: number): Promise<string> {
  const pattern = sqlStr(query);
  const memQuery = `SELECT path, summary::text AS content, 0 AS source_order FROM "${MEMORY_TABLE}" WHERE summary::text ILIKE '%${pattern}%' LIMIT ${limit}`;
  const sessQuery = `SELECT path, message::text AS content, 1 AS source_order FROM "${SESSIONS_TABLE}" WHERE message::text ILIKE '%${pattern}%' LIMIT ${limit}`;
  const sql = `SELECT path, content, source_order FROM ((${memQuery}) UNION ALL (${sessQuery})) AS combined ORDER BY path, source_order LIMIT ${limit}`;
  const rows = await dlQuery(creds, sql);
  if (rows.length === 0) return `No matches for "${query}".`;
  return rows
    .map((r: any) => `[${r.path}]\n${String(r.content ?? "").slice(0, 600)}`)
    .join("\n\n---\n\n");
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
    async execute({ query, limit }: { query: string; limit?: number }) {
      const creds = loadCreds();
      if (!creds) return "Hivemind: not authenticated. Run `hivemind login` in a terminal.";
      try {
        return await searchTables(creds, query, limit ?? 10);
      } catch (err: any) {
        return `Hivemind search failed: ${err.message}`;
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
    async execute({ path }: { path: string }) {
      const creds = loadCreds();
      if (!creds) return "Hivemind: not authenticated.";
      const isSession = path.startsWith("/sessions/");
      const table = isSession ? SESSIONS_TABLE : MEMORY_TABLE;
      const col = isSession ? "message::text" : "summary::text";
      const sql = `SELECT path, ${col} AS content FROM "${table}" WHERE path = '${sqlStr(path)}' LIMIT 200`;
      try {
        const rows = await dlQuery(creds, sql);
        if (rows.length === 0) return `No content at ${path}.`;
        return rows.map((r: any) => String(r.content ?? "")).join("\n");
      } catch (err: any) {
        return `Hivemind read failed: ${err.message}`;
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
    async execute({ prefix, limit }: { prefix?: string; limit?: number }) {
      const creds = loadCreds();
      if (!creds) return "Hivemind: not authenticated.";
      const where = prefix
        ? `WHERE path LIKE '${sqlStr(prefix)}%'`
        : `WHERE path LIKE '/summaries/%'`;
      const sql = `SELECT path, description, project, last_update_date FROM "${MEMORY_TABLE}" ${where} ORDER BY last_update_date DESC LIMIT ${limit ?? 50}`;
      try {
        const rows = await dlQuery(creds, sql);
        if (rows.length === 0) return "No summaries.";
        return rows
          .map((r: any) => `${r.path}\t${r.last_update_date}\t${r.project ?? ""}\t${r.description ?? ""}`)
          .join("\n");
      } catch (err: any) {
        return `Hivemind index failed: ${err.message}`;
      }
    },
  });

  // --- Lifecycle hooks (capture path) -----------------------------------------

  pi.on("session_start", async (event: any) => {
    const creds = loadCreds();
    const additional = creds
      ? `${CONTEXT_PREAMBLE}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId}).`
      : `${CONTEXT_PREAMBLE}\nNot logged in to Deeplake. Run \`hivemind login\` to authenticate.`;
    return { additionalContext: additional };
  });

  pi.on("input", async (event: any) => {
    if (!captureEnabled) return;
    const creds = loadCreds();
    if (!creds) return;
    const sessionId = event.sessionId ?? event.session_id ?? `pi-${Date.now()}`;
    const text = typeof event.input === "string" ? event.input : event.text ?? "";
    if (!text) return;
    try {
      await writeSessionRow(creds, sessionId, "pi", "input", event.cwd ?? process.cwd(), {
        id: crypto.randomUUID(),
        type: "user_message",
        session_id: sessionId,
        content: text,
        timestamp: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  });

  pi.on("tool_result", async (event: any) => {
    if (!captureEnabled) return;
    const creds = loadCreds();
    if (!creds) return;
    const sessionId = event.sessionId ?? event.session_id ?? `pi-${Date.now()}`;
    try {
      await writeSessionRow(creds, sessionId, "pi", "tool_result", event.cwd ?? process.cwd(), {
        id: crypto.randomUUID(),
        type: "tool_call",
        session_id: sessionId,
        tool_name: event.toolName ?? event.tool_name ?? "unknown",
        tool_input: JSON.stringify(event.toolInput ?? event.input ?? {}),
        tool_response: JSON.stringify(event.result ?? event.toolResult ?? null),
        timestamp: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  });

  pi.on("message_end", async (event: any) => {
    if (!captureEnabled) return;
    const creds = loadCreds();
    if (!creds) return;
    const sessionId = event.sessionId ?? event.session_id ?? `pi-${Date.now()}`;
    const message = event.message ?? event.assistantMessage ?? null;
    if (!message) return;
    const text = typeof message === "string"
      ? message
      : Array.isArray(message?.content)
        ? message.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
        : (message?.content ?? message?.text ?? "");
    if (!text) return;
    try {
      await writeSessionRow(creds, sessionId, "pi", "message_end", event.cwd ?? process.cwd(), {
        id: crypto.randomUUID(),
        type: "assistant_message",
        session_id: sessionId,
        content: text,
        timestamp: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  });

  pi.on("session_shutdown", async () => {
    // No-op for now. Future: trigger wiki-worker for AI summary.
  });
}
