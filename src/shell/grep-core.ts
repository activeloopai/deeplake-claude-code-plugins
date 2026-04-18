/**
 * Shared grep core for the plugin. Used by:
 *   - src/hooks/grep-direct.ts  (fast-path from pre-tool-use)
 *   - src/shell/grep-interceptor.ts  (slow-path inside deeplake-shell)
 *
 * Responsibilities:
 *   1. searchDeeplakeTables: run parallel LIKE/ILIKE queries against both the
 *      memory table (summaries, column `summary`) AND the sessions table
 *      (raw dialogue, column `message` JSONB), returning {path, content}.
 *   2. normalizeSessionContent: when a row comes from a session path, turn the
 *      single-line JSON blob into multi-line "Speaker: text" so the standard
 *      line-wise regex refinement surfaces only matching turns, not the whole
 *      5 KB blob.
 *   3. refineGrepMatches: line-by-line regex match with the usual grep flags.
 */

import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr, sqlLike } from "../utils/sql.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GrepMatchParams {
  pattern: string;
  ignoreCase: boolean;
  wordMatch: boolean;
  filesOnly: boolean;
  countOnly: boolean;
  lineNumber: boolean;
  invertMatch: boolean;
  fixedString: boolean;
}

export interface ContentRow {
  path: string;
  content: string;
}

export interface SearchOptions {
  /** SQL path filter to apply to BOTH queries, e.g. ` AND (path = '/x' OR path LIKE '/x/%')`. Empty string = no filter. */
  pathFilter: string;
  /** true → fetch all rows under pathFilter (caller will regex in-memory). false → filter server-side by LIKE/ILIKE. */
  contentScanOnly: boolean;
  /** "LIKE" | "ILIKE" — case matters. */
  likeOp: "LIKE" | "ILIKE";
  /** LIKE-escaped pattern (via sqlLike). */
  escapedPattern: string;
  /** Optional safe literal anchor for regex searches (e.g. foo.*bar → foo). */
  prefilterPattern?: string;
  /** Per-table row cap. */
  limit?: number;
}

// ── Content normalization ───────────────────────────────────────────────────

/**
 * If the row is a session JSON blob, serialize it as multi-line
 * "Speaker: text" so the standard grep refinement surfaces only matching turns.
 * Falls back to the raw content if parsing fails or the path is not a session.
 */
// ── Tool-call extractor ─────────────────────────────────────────────────────
// Extracts only signal-bearing fields from `tool_input` / `tool_response`,
// dropping wrapper noise (booleans, type tags, empty strings) and fields
// duplicated between input and response. DB bytes are untouched; this is a
// read-time view. Covers every (agent, tool_name) shape observed in the
// production workspace.

const TOOL_INPUT_FIELDS = [
  "command", "file_path", "path", "pattern", "prompt", "subagent_type",
  "query", "url", "notebook_path", "old_string", "new_string", "content",
  "skill", "args", "taskId", "status", "subject", "description",
  "to", "message", "summary", "max_results",
] as const;

const TOOL_RESPONSE_DROP = new Set([
  // Note: `stderr` is intentionally NOT in this set. The `stdout` high-signal
  // branch below already de-dupes it for the common case (appends as suffix
  // when non-empty). If a tool response has ONLY `stderr` and no `stdout`
  // (hard-failure on some tools), the generic cleanup preserves it so the
  // error message reaches Claude instead of collapsing to `[ok]`.
  "interrupted", "isImage", "noOutputExpected", "type",
  "structuredPatch", "userModified", "originalFile", "replaceAll",
  "totalDurationMs", "totalTokens", "totalToolUseCount", "usage", "toolStats",
  "durationMs", "durationSeconds", "bytes", "code", "codeText",
  "agentId", "agentType",
  "verificationNudgeNeeded", "numLines", "numFiles", "truncated",
  "statusChange", "updatedFields", "isAgent", "success",
]);

function maybeParseJson(v: unknown): any {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s[0] !== "{" && s[0] !== "[") return v;
  try { return JSON.parse(s); } catch { return v; }
}

function snakeCase(k: string): string { return k.replace(/([A-Z])/g, "_$1").toLowerCase(); }
function camelCase(k: string): string { return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

function formatToolInput(raw: unknown): string {
  const p = maybeParseJson(raw);
  if (typeof p !== "object" || p === null) return String(p ?? "");
  const parts: string[] = [];
  for (const k of TOOL_INPUT_FIELDS) {
    if ((p as any)[k] === undefined) continue;
    const v = (p as any)[k];
    parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  // minor modifiers
  for (const k of ["glob", "output_mode", "limit", "offset"] as const) {
    if ((p as any)[k] !== undefined) parts.push(`${k}: ${(p as any)[k]}`);
  }
  return parts.length ? parts.join("\n") : JSON.stringify(p);
}

function formatToolResponse(raw: unknown, inp: unknown, toolName: string | undefined): string {
  const r = maybeParseJson(raw);
  if (typeof r !== "object" || r === null) return String(r ?? "");
  // Side-effect tools — their response is pure metadata; confirm and move on.
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return (r as any).filePath ? `[wrote ${(r as any).filePath}]` : "[ok]";
  }
  // High-signal fields — return the useful payload directly.
  if (typeof (r as any).stdout === "string") {
    const stderr = (r as any).stderr;
    return (r as any).stdout + (stderr ? `\nstderr: ${stderr}` : "");
  }
  if (typeof (r as any).content === "string") return (r as any).content;
  if ((r as any).file && typeof (r as any).file === "object") {
    const f = (r as any).file;
    if (typeof f.content === "string") return `[${f.filePath ?? ""}]\n${f.content}`;
    if (typeof f.base64 === "string") return `[binary ${f.filePath ?? ""}: ${f.base64.length} base64 chars]`;
  }
  if (Array.isArray((r as any).filenames)) return (r as any).filenames.join("\n");
  if (Array.isArray((r as any).matches)) {
    return (r as any).matches.map((m: unknown) => typeof m === "string" ? m : JSON.stringify(m)).join("\n");
  }
  if (Array.isArray((r as any).results)) {
    return (r as any).results.map((x: any) => typeof x === "string" ? x : (x?.title ?? x?.url ?? JSON.stringify(x))).join("\n");
  }
  // Generic cleanup for less common tools: drop known-noisy keys + values
  // duplicated from input (including snake↔camel variants).
  const inpObj = maybeParseJson(inp);
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as any)) {
    if (TOOL_RESPONSE_DROP.has(k)) continue;
    if (v === "" || v === false || v == null) continue;
    if (typeof inpObj === "object" && inpObj) {
      const inObj = inpObj as Record<string, unknown>;
      if (k in inObj && JSON.stringify(inObj[k]) === JSON.stringify(v)) continue;
      const snake = snakeCase(k);
      if (snake in inObj && JSON.stringify(inObj[snake]) === JSON.stringify(v)) continue;
      const camel = camelCase(k);
      if (camel in inObj && JSON.stringify(inObj[camel]) === JSON.stringify(v)) continue;
    }
    kept[k] = v;
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : "[ok]";
}

function formatToolCall(obj: any): string {
  return `[tool:${obj?.tool_name ?? "?"}]\ninput: ${formatToolInput(obj?.tool_input)}\nresponse: ${formatToolResponse(obj?.tool_response, obj?.tool_input, obj?.tool_name)}`;
}

export function normalizeContent(path: string, raw: string): string {
  // Any unknown shape falls through to `raw` below. This function never
  // returns null/empty — if the result would be trivially empty (e.g.
  // "[user] " with no content), we fall back to `raw` so grep still has
  // something to scan.
  if (!path.includes("/sessions/")) return raw;
  if (!raw || raw[0] !== "{") return raw;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return raw; }

  // ── LoCoMo benchmark shape: { turns: [...] } ─────────────────────────────
  if (Array.isArray(obj.turns)) {
    const header: string[] = [];
    if (obj.date_time) header.push(`date: ${obj.date_time}`);
    if (obj.speakers) {
      const s = obj.speakers;
      const names = [s.speaker_a, s.speaker_b].filter(Boolean).join(", ");
      if (names) header.push(`speakers: ${names}`);
    }
    const lines = obj.turns.map((t: any) => {
      const sp = String(t?.speaker ?? t?.name ?? "?").trim();
      const tx = String(t?.text ?? t?.content ?? "").replace(/\s+/g, " ").trim();
      const tag = t?.dia_id ? `[${t.dia_id}] ` : "";
      return `${tag}${sp}: ${tx}`;
    });
    const out = [...header, ...lines].join("\n");
    return out.trim() ? out : raw;
  }

  // ── Production shape: single hook-event row (capture.ts output) ─────────
  //
  // `<recalled-memories>` blocks are injected by OpenClaw as extra context
  // before user prompts. They contain serialized JSON of past events which
  // already live as their own rows in the sessions table — keeping them
  // duplicates every hit and drowns the actual prompt. Greedy strip from
  // first open to last close handles nested tags (past events that
  // themselves had a recalled-memories wrapper).
  const stripRecalled = (t: string): string => {
    const i = t.indexOf("<recalled-memories>");
    if (i === -1) return t;
    const j = t.lastIndexOf("</recalled-memories>");
    if (j === -1 || j < i) return t; // malformed — leave intact
    const head = t.slice(0, i);
    const tail = t.slice(j + "</recalled-memories>".length);
    return (head + tail).replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
  };

  let out: string | null = null;
  if (obj.type === "user_message") {
    out = `[user] ${stripRecalled(String(obj.content ?? ""))}`;
  } else if (obj.type === "assistant_message") {
    const agent = obj.agent_type ? ` (agent=${obj.agent_type})` : "";
    out = `[assistant${agent}] ${stripRecalled(String(obj.content ?? ""))}`;
  } else if (obj.type === "tool_call") {
    out = formatToolCall(obj);
  }

  // Safe fallback for any unknown shape or trivially empty result.
  if (out === null) return raw;
  const trimmed = out.trim();
  if (!trimmed || trimmed === "[user]" || trimmed === "[assistant]" || /^\[tool:[^\]]*\]\s+input:\s+\{\}\s+response:\s+\{\}$/.test(trimmed)) return raw;
  return out;
}

// ── SQL search (both tables in parallel) ────────────────────────────────────

/**
 * Dual-table LIKE/ILIKE search. Casts `summary` (TEXT) and `message` (JSONB)
 * to ::text so the same predicate works across both. Both queries run in
 * parallel; if one fails, the other's rows are still returned.
 */
export async function searchDeeplakeTables(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  opts: SearchOptions,
): Promise<ContentRow[]> {
  const { pathFilter, contentScanOnly, likeOp, escapedPattern, prefilterPattern } = opts;
  const limit = opts.limit ?? 100;
  const filterPattern = contentScanOnly ? prefilterPattern : escapedPattern;

  const memFilter = filterPattern ? ` AND summary::text ${likeOp} '%${filterPattern}%'` : "";
  const sessFilter = filterPattern ? ` AND message::text ${likeOp} '%${filterPattern}%'` : "";

  const memQuery = `SELECT path, summary::text AS content FROM "${memoryTable}" WHERE 1=1${pathFilter}${memFilter} LIMIT ${limit}`;
  const sessQuery = `SELECT path, message::text AS content FROM "${sessionsTable}" WHERE 1=1${pathFilter}${sessFilter} LIMIT ${limit}`;

  const [memRows, sessRows] = await Promise.all([
    api.query(memQuery).catch(() => []),
    api.query(sessQuery).catch(() => []),
  ]);

  const rows: ContentRow[] = [];
  for (const r of memRows) rows.push({ path: String(r.path), content: String(r.content ?? "") });
  for (const r of sessRows) rows.push({ path: String(r.path), content: String(r.content ?? "") });
  return rows;
}

/** Build a LIKE pathFilter clause for a `path` column. Returns "" if targetPath is root or empty. */
export function buildPathFilter(targetPath: string): string {
  if (!targetPath || targetPath === "/") return "";
  const clean = targetPath.replace(/\/+$/, "");
  return ` AND (path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%')`;
}

/**
 * Extract a safe literal substring from a regex-like grep pattern.
 * Only patterns composed of plain text plus `.*` wildcards qualify.
 * Example: `foo.*bar` → `foo` (or `bar`), `colou?r` → null.
 */
export function extractRegexLiteralPrefilter(pattern: string): string | null {
  if (!pattern) return null;

  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!next) return null;
      if (/[dDsSwWbBAZzGkKpP]/.test(next)) return null;
      current += next;
      i++;
      continue;
    }
    if (ch === ".") {
      if (pattern[i + 1] === "*") {
        if (current) parts.push(current);
        current = "";
        i++;
        continue;
      }
      return null;
    }
    if ("|()[]{}+?^$".includes(ch) || ch === "*") return null;
    current += ch;
  }
  if (current) parts.push(current);

  const literal = parts.reduce((best, part) => part.length > best.length ? part : best, "");
  return literal.length >= 2 ? literal : null;
}

export function buildGrepSearchOptions(params: GrepMatchParams, targetPath: string): SearchOptions {
  const hasRegexMeta = !params.fixedString && /[.*+?^${}()|[\]\\]/.test(params.pattern);
  const literalPrefilter = hasRegexMeta ? extractRegexLiteralPrefilter(params.pattern) : null;
  return {
    pathFilter: buildPathFilter(targetPath),
    contentScanOnly: hasRegexMeta,
    likeOp: params.ignoreCase ? "ILIKE" : "LIKE",
    escapedPattern: sqlLike(params.pattern),
    prefilterPattern: literalPrefilter ? sqlLike(literalPrefilter) : undefined,
  };
}

// ── Regex refinement (line-by-line grep) ────────────────────────────────────

/** Compile the grep regex from params, with a safe fallback on bad user regex. */
export function compileGrepRegex(params: GrepMatchParams): RegExp {
  let reStr = params.fixedString
    ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : params.pattern;
  if (params.wordMatch) reStr = `\\b${reStr}\\b`;
  try {
    return new RegExp(reStr, params.ignoreCase ? "i" : "");
  } catch {
    return new RegExp(
      params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      params.ignoreCase ? "i" : "",
    );
  }
}

/**
 * Line-by-line grep refinement over already-fetched rows. Caller is expected
 * to have normalized `content` (e.g. via normalizeContent) before calling.
 */
export function refineGrepMatches(
  rows: ContentRow[],
  params: GrepMatchParams,
  forceMultiFilePrefix?: boolean,
): string[] {
  const re = compileGrepRegex(params);
  const multi = forceMultiFilePrefix ?? rows.length > 1;
  const output: string[] = [];

  for (const row of rows) {
    if (!row.content) continue;
    const lines = row.content.split("\n");
    const matched: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const hit = re.test(lines[i]);
      if (hit !== !!params.invertMatch) {
        if (params.filesOnly) { output.push(row.path); break; }
        const prefix = multi ? `${row.path}:` : "";
        const ln = params.lineNumber ? `${i + 1}:` : "";
        matched.push(`${prefix}${ln}${lines[i]}`);
      }
    }

    if (!params.filesOnly) {
      if (params.countOnly) {
        output.push(`${multi ? `${row.path}:` : ""}${matched.length}`);
      } else {
        output.push(...matched);
      }
    }
  }

  return output;
}

/** Convenience: search both tables, normalize session JSON, then refine. */
export async function grepBothTables(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  params: GrepMatchParams,
  targetPath: string,
): Promise<string[]> {
  const rows = await searchDeeplakeTables(api, memoryTable, sessionsTable, buildGrepSearchOptions(params, targetPath));
  // Defensive path dedup — memory and sessions tables use disjoint path
  // prefixes in every schema we ship (/summaries/… vs /sessions/…), so the
  // overlap is theoretical, but we dedupe to match grep-interceptor.ts and
  // guarantee each path is emitted once even if a future schema change
  // introduces overlap.
  const seen = new Set<string>();
  const unique = rows.filter(r => seen.has(r.path) ? false : (seen.add(r.path), true));
  const normalized = unique.map(r => ({ path: r.path, content: normalizeContent(r.path, r.content) }));
  return refineGrepMatches(normalized, params);
}
