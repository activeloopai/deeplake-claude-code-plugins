/**
 * Shared grep core for the plugin. Used by:
 *   - src/hooks/grep-direct.ts  (fast-path from pre-tool-use)
 *   - src/shell/grep-interceptor.ts  (slow-path inside deeplake-shell)
 *
 * Responsibilities:
 *   1. searchDeeplakeTables: run one UNION ALL query across both the memory
 *      table (summaries, column `summary`) AND the sessions table
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
  /** Optional safe literal alternation anchors for regex searches (e.g. foo|bar). */
  prefilterPatterns?: string[];
  /** Per-word patterns for non-regex multi-word queries (OR-joined). */
  multiWordPatterns?: string[];
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

  // ── Turn-array session shape: { turns: [...] } ───────────────────────────
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

function buildPathCondition(targetPath: string): string {
  if (!targetPath || targetPath === "/") return "";
  const clean = targetPath.replace(/\/+$/, "");
  if (/[*?]/.test(clean)) {
    const likePattern = sqlLike(clean).replace(/\*/g, "%").replace(/\?/g, "_");
    return `path LIKE '${likePattern}' ESCAPE '\\'`;
  }
  const base = clean.split("/").pop() ?? "";
  if (base.includes(".")) {
    return `path = '${sqlStr(clean)}'`;
  }
  return `(path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%' ESCAPE '\\')`;
}

/**
 * Dual-table LIKE/ILIKE search. Casts `summary` (TEXT) and `message` (JSONB)
 * to ::text so the same predicate works across both. The lookup always goes
 * through a single UNION ALL query so one grep maps to one SQL search.
 */
export async function searchDeeplakeTables(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  opts: SearchOptions,
): Promise<ContentRow[]> {
  const { pathFilter, contentScanOnly, likeOp, escapedPattern, prefilterPattern, prefilterPatterns, multiWordPatterns } = opts;
  const limit = opts.limit ?? 100;
  const filterPatterns = contentScanOnly
    ? (prefilterPatterns && prefilterPatterns.length > 0 ? prefilterPatterns : (prefilterPattern ? [prefilterPattern] : []))
    : (multiWordPatterns && multiWordPatterns.length > 1 ? multiWordPatterns : [escapedPattern]);
  const memFilter = buildContentFilter("summary::text", likeOp, filterPatterns);
  const sessFilter = buildContentFilter("message::text", likeOp, filterPatterns);

  const memQuery = `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date FROM "${memoryTable}" WHERE 1=1${pathFilter}${memFilter} LIMIT ${limit}`;
  const sessQuery = `SELECT path, message::text AS content, 1 AS source_order, COALESCE(creation_date::text, '') AS creation_date FROM "${sessionsTable}" WHERE 1=1${pathFilter}${sessFilter} LIMIT ${limit}`;

  const rows = await api.query(
    `SELECT path, content, source_order, creation_date FROM (` +
    `(${memQuery}) UNION ALL (${sessQuery})` +
    `) AS combined ORDER BY path, source_order, creation_date`
  );

  return rows.map(row => ({
    path: String(row["path"]),
    content: String(row["content"] ?? ""),
  }));
}

/** Build a LIKE pathFilter clause for a `path` column. Returns "" if targetPath is root or empty. */
export function buildPathFilter(targetPath: string): string {
  const condition = buildPathCondition(targetPath);
  return condition ? ` AND ${condition}` : "";
}

/** Build one combined pathFilter clause for multiple grep targets. */
export function buildPathFilterForTargets(targetPaths: string[]): string {
  if (targetPaths.some((targetPath) => !targetPath || targetPath === "/")) return "";
  const conditions = [...new Set(
    targetPaths
      .map((targetPath) => buildPathCondition(targetPath))
      .filter((condition): condition is string => condition.length > 0),
  )];
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return ` AND ${conditions[0]}`;
  return ` AND (${conditions.join(" OR ")})`;
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

export function extractRegexAlternationPrefilters(pattern: string): string[] | null {
  if (!pattern.includes("|")) return null;

  const parts: string[] = [];
  let current = "";
  let escaped = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      current += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      if (!current) return null;
      parts.push(current);
      current = "";
      continue;
    }
    if ("()[]{}^$".includes(ch)) return null;
    current += ch;
  }

  if (escaped || !current) return null;
  parts.push(current);

  const literals = [...new Set(
    parts
      .map((part) => extractRegexLiteralPrefilter(part))
      .filter((part): part is string => typeof part === "string" && part.length >= 2),
  )];
  return literals.length > 0 ? literals : null;
}

export function buildGrepSearchOptions(params: GrepMatchParams, targetPath: string): SearchOptions {
  const hasRegexMeta = !params.fixedString && /[.*+?^${}()|[\]\\]/.test(params.pattern);
  const literalPrefilter = hasRegexMeta ? extractRegexLiteralPrefilter(params.pattern) : null;
  const alternationPrefilters = hasRegexMeta ? extractRegexAlternationPrefilters(params.pattern) : null;
  // For non-regex multi-word patterns, split into per-word OR filters so
  // natural-language queries match any token, not only the full phrase.
  const multiWordPatterns = (!hasRegexMeta)
    ? params.pattern.split(/\s+/).filter((w) => w.length > 2).slice(0, 4)
    : [];

  return {
    pathFilter: buildPathFilter(targetPath),
    contentScanOnly: hasRegexMeta,
    likeOp: params.ignoreCase ? "ILIKE" : "LIKE",
    escapedPattern: sqlLike(params.pattern),
    prefilterPattern: literalPrefilter ? sqlLike(literalPrefilter) : undefined,
    prefilterPatterns: alternationPrefilters?.map((literal) => sqlLike(literal)),
    multiWordPatterns: multiWordPatterns.length > 1
      ? multiWordPatterns.map((w) => sqlLike(w))
      : undefined,
  };
}

function buildContentFilter(
  column: string,
  likeOp: "LIKE" | "ILIKE",
  patterns: string[],
): string {
  if (patterns.length === 0) return "";
  if (patterns.length === 1) return ` AND ${column} ${likeOp} '%${patterns[0]}%'`;
  return ` AND (${patterns.map((pattern) => `${column} ${likeOp} '%${pattern}%'`).join(" OR ")})`;
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
