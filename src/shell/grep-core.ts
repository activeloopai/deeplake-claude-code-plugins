/**
 * Shared grep core for the plugin. Used by:
 *   - src/hooks/grep-direct.ts  (fast-path from pre-tool-use)
 *   - src/shell/grep-interceptor.ts  (slow-path inside deeplake-shell)
 *
 * Responsibilities:
 *   1. searchDeeplakeTables: run one UNION ALL query across both the memory
 *      table (summaries, column `summary`) AND the sessions table
 *      (raw dialogue, column `message` JSONB), returning {path, content}.
 *   2. normalizeSessionContent: when a row comes from a session path, expose a
 *      file-like text view. Transcript JSON blobs stay as canonical pretty
 *      JSON so local grep/read over `/sessions/*.json` matches the plugin
 *      surface, while production hook-event rows keep their concise normalized
 *      text view.
 *   3. refineGrepMatches: line-by-line regex match with the usual grep flags.
 */

import type { DeeplakeApi } from "../deeplake-api.js";
import { HarrierEmbedder } from "../embeddings/harrier.js";
import { sqlStr, sqlLike } from "../utils/sql.js";
import { getGrepRetrievalMode, isSessionsOnlyMode, isSummaryBm25Disabled } from "../utils/retrieval-mode.js";

const DEFAULT_GREP_CANDIDATE_LIMIT = Number(
  process.env["HIVEMIND_GREP_LIMIT"]
  ?? process.env["DEEPLAKE_GREP_LIMIT"]
  ?? 500,
);
const DEFAULT_EMBED_RETRIEVAL_MODEL_ID = "onnx-community/harrier-oss-v1-270m-ONNX";
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;

let retrievalEmbedder: HarrierEmbedder | null = null;

function envString(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function envFlag(...names: string[]): boolean {
  const raw = envString(...names) ?? "";
  return /^(1|true|yes|on)$/i.test(raw);
}

function envNumber(fallback: number, ...names: string[]): number {
  const raw = envString(...names);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRetrievalEmbedder(): HarrierEmbedder {
  if (!retrievalEmbedder) {
    retrievalEmbedder = new HarrierEmbedder({
      modelId: envString(
        "HIVEMIND_EMBED_RETRIEVAL_MODEL_ID",
        "DEEPLAKE_EMBED_RETRIEVAL_MODEL_ID",
        "HIVEMIND_HARRIER_MODEL_ID",
        "DEEPLAKE_HARRIER_MODEL_ID",
      ) ?? DEFAULT_EMBED_RETRIEVAL_MODEL_ID,
      device: envString("HIVEMIND_EMBED_RETRIEVAL_DEVICE", "DEEPLAKE_EMBED_RETRIEVAL_DEVICE") ?? "cpu",
      dtype: envString("HIVEMIND_EMBED_RETRIEVAL_DTYPE", "DEEPLAKE_EMBED_RETRIEVAL_DTYPE"),
      cacheDir: envString("HIVEMIND_EMBED_RETRIEVAL_CACHE_DIR", "DEEPLAKE_EMBED_RETRIEVAL_CACHE_DIR"),
      localModelPath: envString("HIVEMIND_EMBED_RETRIEVAL_LOCAL_MODEL_PATH", "DEEPLAKE_EMBED_RETRIEVAL_LOCAL_MODEL_PATH"),
      localFilesOnly: envFlag("HIVEMIND_EMBED_RETRIEVAL_LOCAL_FILES_ONLY", "DEEPLAKE_EMBED_RETRIEVAL_LOCAL_FILES_ONLY"),
    });
  }
  return retrievalEmbedder;
}

function sqlFloat4Array(values: number[]): string {
  if (values.length === 0) throw new Error("Query embedding is empty");
  return `ARRAY[${values.map((value) => {
    if (!Number.isFinite(value)) throw new Error("Query embedding contains non-finite values");
    return Math.fround(value).toString();
  }).join(", ")}]::float4[]`;
}

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
  /** Optional raw grep regex pattern. May be normalized before SQL pushdown. */
  regexPattern?: string;
  /** Optional safe literal anchor for regex searches (e.g. foo.*bar → foo). */
  prefilterPattern?: string;
  /** Optional safe literal alternation anchors for regex searches (e.g. foo|bar). */
  prefilterPatterns?: string[];
  /** Optional semantic query text used for vector and hybrid retrieval. */
  queryText?: string;
  /** Optional lexical query text for BM25 summary retrieval. */
  bm25QueryText?: string;
  /** Per-table row cap. */
  limit?: number;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize common grep BRE operator spellings into the JS/SQL-regex form used
 * by our execution paths. This fixes patterns like `book\\|novel` that grep
 * users often write for alternation.
 */
export function normalizeGrepRegexPattern(pattern: string): string {
  return pattern
    .replace(/\\([|(){}+?])/g, "$1")
    .replace(/\\</g, "\\b")
    .replace(/\\>/g, "\\b");
}

// ── Content normalization ───────────────────────────────────────────────────

/**
 * If the row is a session JSON blob, expose a file-like text view. Transcript
 * blobs (`turns` / `dialogue`) stay as canonical pretty JSON so grep/read
 * match the local filesystem surface. Hook-event rows keep a concise
 * normalized text projection. Falls back to the raw content if parsing fails
 * or the path is not a session.
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

  // ── Transcript session shapes: keep a canonical raw-JSON view ───────────
  if (Array.isArray(obj.turns) || Array.isArray(obj.dialogue)) {
    return `${JSON.stringify(obj, null, 2)}\n`;
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
    return `path LIKE '${likePattern}'`;
  }
  const base = clean.split("/").pop() ?? "";
  if (base.includes(".")) {
    return `path = '${sqlStr(clean)}'`;
  }
  return `(path = '${sqlStr(clean)}' OR path LIKE '${sqlLike(clean)}/%')`;
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
  const { pathFilter, contentScanOnly, likeOp, escapedPattern, regexPattern, prefilterPattern, prefilterPatterns, queryText, bm25QueryText } = opts;
  const limit = opts.limit ?? DEFAULT_GREP_CANDIDATE_LIMIT;
  const filterPatterns = contentScanOnly
    ? (prefilterPatterns && prefilterPatterns.length > 0 ? prefilterPatterns : (prefilterPattern ? [prefilterPattern] : []))
    : [escapedPattern];
  const ignoreCase = likeOp === "ILIKE";
  const likeMemFilter = buildContentFilter("summary::text", likeOp, filterPatterns);
  const likeSessFilter = buildContentFilter("message::text", likeOp, filterPatterns);
  const regexMemFilter = regexPattern ? buildRegexFilter("summary::text", regexPattern, ignoreCase) : "";
  const regexSessFilter = regexPattern ? buildRegexFilter("message::text", regexPattern, ignoreCase) : "";
  // Stay on portable message::text filters for session rows. The structured
  // json_extract_string() predicates currently fail against the managed
  // backend for these JSONB rows, which forces a 400 and a retry onto a
  // coarser query path.
  const primarySessFilter = `${likeSessFilter}${regexSessFilter}`;
  const fallbackSessFilter = likeSessFilter;
  const hasSqlRegexFilter = Boolean(regexMemFilter || regexSessFilter);
  const sessionsOnly = isSessionsOnlyMode();
  const retrievalMode = getGrepRetrievalMode();
  const semanticQueryText = (queryText ?? bm25QueryText ?? "").trim();
  const useEmbeddingRetrieval = retrievalMode === "embedding" && semanticQueryText.length > 0;
  const useHybridRetrieval = retrievalMode === "hybrid" && semanticQueryText.length > 0;
  const useSummaryBm25 = retrievalMode === "classic" && !sessionsOnly && !isSummaryBm25Disabled() && Boolean(bm25QueryText);
  const shouldUseFallbackCapablePrimary = useSummaryBm25
    || hasSqlRegexFilter;
  const ensureSummaryBm25Index = (api as DeeplakeApi & {
    ensureSummaryBm25Index?: (tableName?: string) => Promise<void>;
  }).ensureSummaryBm25Index;

  if (useSummaryBm25 && typeof ensureSummaryBm25Index === "function") {
    await ensureSummaryBm25Index.call(api, memoryTable).catch(() => {});
  }

  const buildCombinedQuery = (memFilter: string, sessFilter: string, useBm25Summary = false): string => {
    const memQuery = useBm25Summary
      ? buildSummaryBm25Query(memoryTable, pathFilter, bm25QueryText ?? "", limit)
      : `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date FROM "${memoryTable}" WHERE 1=1${pathFilter}${memFilter} LIMIT ${limit}`;
    const sessQuery = `SELECT path, message::text AS content, 1 AS source_order, COALESCE(creation_date::text, '') AS creation_date FROM "${sessionsTable}" WHERE 1=1${pathFilter}${sessFilter} LIMIT ${limit}`;
    return sessionsOnly
      ? `SELECT path, content, source_order, creation_date FROM (${sessQuery}) AS combined ORDER BY path, source_order, creation_date`
      : `SELECT path, content, source_order, creation_date FROM ((${memQuery}) UNION ALL (${sessQuery})) AS combined ORDER BY path, source_order, creation_date`;
  };

  if (useEmbeddingRetrieval || useHybridRetrieval) {
    const embedder = getRetrievalEmbedder();
    const [queryEmbedding] = await embedder.embedQueries([semanticQueryText]);
    if (!queryEmbedding) throw new Error("Failed to build query embedding");
    const queryVectorSql = sqlFloat4Array(queryEmbedding);
    const vectorWeight = envNumber(DEFAULT_HYBRID_VECTOR_WEIGHT, "HIVEMIND_HYBRID_VECTOR_WEIGHT", "DEEPLAKE_HYBRID_VECTOR_WEIGHT");
    const textWeight = envNumber(DEFAULT_HYBRID_TEXT_WEIGHT, "HIVEMIND_HYBRID_TEXT_WEIGHT", "DEEPLAKE_HYBRID_TEXT_WEIGHT");
    const buildSemanticCombinedQuery = (): string => {
      const memQuery = useHybridRetrieval
        ? buildHybridSimilarityQuery(
            memoryTable,
            pathFilter,
            "summary::text",
            0,
            "''",
            queryVectorSql,
            semanticQueryText,
            vectorWeight,
            textWeight,
            limit,
          )
        : buildEmbeddingSimilarityQuery(
            memoryTable,
            pathFilter,
            "summary::text",
            0,
            "''",
            queryVectorSql,
            limit,
          );
      const sessQuery = useHybridRetrieval
        ? buildHybridSimilarityQuery(
            sessionsTable,
            pathFilter,
            "message::text",
            1,
            "COALESCE(creation_date::text, '')",
            queryVectorSql,
            semanticQueryText,
            vectorWeight,
            textWeight,
            limit,
          )
        : buildEmbeddingSimilarityQuery(
            sessionsTable,
            pathFilter,
            "message::text",
            1,
            "COALESCE(creation_date::text, '')",
            queryVectorSql,
            limit,
          );
      return sessionsOnly
        ? `SELECT path, content, source_order, creation_date FROM (${sessQuery}) AS combined ORDER BY path, source_order, creation_date`
        : `SELECT path, content, source_order, creation_date FROM ((${memQuery}) UNION ALL (${sessQuery})) AS combined ORDER BY path, source_order, creation_date`;
    };
    const rows = await api.query(buildSemanticCombinedQuery());
    return rows.map(row => ({
      path: String(row["path"]),
      content: String(row["content"] ?? ""),
    }));
  }

  const primaryMemFilter = useSummaryBm25 ? "" : `${likeMemFilter}${regexMemFilter}`;
  const primaryQuery = buildCombinedQuery(primaryMemFilter, primarySessFilter, useSummaryBm25);
  const fallbackQuery = buildCombinedQuery(likeMemFilter, fallbackSessFilter, false);

  const rows = shouldUseFallbackCapablePrimary
    ? await api.query(primaryQuery).catch(() => api.query(fallbackQuery))
    : await api.query(primaryQuery);

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
      if (/[bByYmM<>]/.test(next)) {
        i++;
        continue;
      }
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
  const unwrapped = unwrapWholeRegexGroup(pattern);
  if (!unwrapped.includes("|")) return null;

  const parts: string[] = [];
  let current = "";
  let escaped = false;

  for (let i = 0; i < unwrapped.length; i++) {
    const ch = unwrapped[i];
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
  const normalizedPattern = params.fixedString ? params.pattern : normalizeGrepRegexPattern(params.pattern);
  const hasRegexMeta = !params.fixedString && /[.*+?^${}()|[\]\\]/.test(normalizedPattern);
  const literalPrefilter = hasRegexMeta ? extractRegexLiteralPrefilter(normalizedPattern) : null;
  const alternationPrefilters = hasRegexMeta ? extractRegexAlternationPrefilters(normalizedPattern) : null;
  const bm25QueryText = buildSummaryBm25QueryText(normalizedPattern, params.fixedString, literalPrefilter, alternationPrefilters);
  const queryText = (bm25QueryText ?? normalizedPattern.trim()) || undefined;
  const regexBase = params.fixedString ? escapeRegexLiteral(normalizedPattern) : normalizedPattern;
  const sqlRegexPattern = params.wordMatch
    ? `\\b(?:${regexBase})\\b`
    : hasRegexMeta
      ? regexBase
      : undefined;
  return {
    pathFilter: buildPathFilter(targetPath),
    contentScanOnly: hasRegexMeta,
    likeOp: params.ignoreCase ? "ILIKE" : "LIKE",
    escapedPattern: sqlLike(params.pattern),
    regexPattern: sqlRegexPattern,
    prefilterPattern: literalPrefilter ? sqlLike(literalPrefilter) : undefined,
    prefilterPatterns: alternationPrefilters?.map((literal) => sqlLike(literal)),
    queryText,
    bm25QueryText: bm25QueryText ?? undefined,
    limit: DEFAULT_GREP_CANDIDATE_LIMIT,
  };
}

export function buildSummaryBm25QueryText(
  pattern: string,
  fixedString: boolean,
  literalPrefilter: string | null,
  alternationPrefilters: string[] | null,
): string | null {
  const rawTokens = alternationPrefilters && alternationPrefilters.length > 0
    ? alternationPrefilters
    : literalPrefilter
      ? [literalPrefilter]
      : [pattern];

  const cleaned = [...new Set(
    rawTokens
      .flatMap((token) => token
        .replace(/\\b/g, " ")
        .replace(/[.*+?^${}()[\]{}|\\]/g, " ")
        .split(/\s+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )];

  if (cleaned.length === 0) {
    return fixedString && pattern.trim().length >= 2 ? pattern.trim() : null;
  }
  return cleaned.join(" ");
}

function buildContentFilter(
  column: string,
  likeOp: "LIKE" | "ILIKE",
  patterns: string[],
): string {
  const predicate = buildContentPredicate(column, likeOp, patterns);
  return predicate ? ` AND ${predicate}` : "";
}

function buildRegexFilter(
  column: string,
  pattern: string,
  ignoreCase: boolean,
): string {
  const predicate = buildRegexPredicate(column, pattern, ignoreCase);
  return predicate ? ` AND ${predicate}` : "";
}

function buildSummaryBm25Query(
  memoryTable: string,
  pathFilter: string,
  queryText: string,
  limit: number,
): string {
  return `SELECT path, summary::text AS content, 0 AS source_order, '' AS creation_date FROM "${memoryTable}" WHERE 1=1${pathFilter} ORDER BY (summary <#> '${sqlStr(queryText)}') DESC LIMIT ${limit}`;
}

function buildEmbeddingSimilarityQuery(
  tableName: string,
  pathFilter: string,
  contentExpr: string,
  sourceOrder: number,
  creationDateExpr: string,
  queryVectorSql: string,
  limit: number,
): string {
  return `SELECT path, ${contentExpr} AS content, ${sourceOrder} AS source_order, ${creationDateExpr} AS creation_date FROM "${tableName}" WHERE 1=1${pathFilter} AND embedding IS NOT NULL ORDER BY (embedding <#> ${queryVectorSql}) DESC LIMIT ${limit}`;
}

function buildHybridSimilarityQuery(
  tableName: string,
  pathFilter: string,
  contentExpr: string,
  sourceOrder: number,
  creationDateExpr: string,
  queryVectorSql: string,
  queryText: string,
  vectorWeight: number,
  textWeight: number,
  limit: number,
): string {
  return `SELECT path, ${contentExpr} AS content, ${sourceOrder} AS source_order, ${creationDateExpr} AS creation_date FROM "${tableName}" WHERE 1=1${pathFilter} AND embedding IS NOT NULL ORDER BY (((embedding, ${contentExpr})::deeplake_hybrid_record) <#> deeplake_hybrid_record(${queryVectorSql}, '${sqlStr(queryText)}', ${vectorWeight}, ${textWeight})) DESC LIMIT ${limit}`;
}

export function toSqlRegexPattern(
  pattern: string,
  ignoreCase: boolean,
): string | null {
  if (!pattern) return null;

  // Deeplake SQL supports `~` but not `~*`. For ignore-case regex searches,
  // rely on LIKE/ILIKE prefilters plus in-memory regex refinement instead of
  // pushing an incompatible SQL operator.
  if (ignoreCase) return null;

  try {
    new RegExp(pattern);
    return translateRegexPatternToSql(pattern);
  } catch {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

function isSqlRegexPushdownSafe(pattern: string): boolean {
  // The managed backend rejects some otherwise valid JS regexes, especially
  // patterns with bracket syntax, anchors, or escaped literals like `^\[`.
  // Keep SQL regex pushdown to a conservative subset and rely on in-memory
  // refinement after candidate fetch for everything else.
  return !/[\\[\]{}^$]/.test(pattern) && !/\(\?/.test(pattern);
}

function unwrapWholeRegexGroup(pattern: string): string {
  if (!pattern.startsWith("(") || !pattern.endsWith(")")) return pattern;

  let depth = 0;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0 && i !== pattern.length - 1) return pattern;
    }
  }
  if (depth !== 0) return pattern;
  if (pattern.startsWith("(?:")) return pattern.slice(3, -1);
  return pattern.slice(1, -1);
}

function translateRegexPatternToSql(pattern: string): string | null {
  let out = "";

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!next) return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
      switch (next) {
        case "d": out += "[[:digit:]]"; continue;
        case "D": out += "[^[:digit:]]"; continue;
        case "s": out += "[[:space:]]"; continue;
        case "S": out += "[^[:space:]]"; continue;
        case "w": out += "[[:alnum:]_]"; continue;
        case "W": out += "[^[:alnum:]_]"; continue;
        case "b": out += "\\y"; continue;
        case "A":
        case "B":
        case "G":
        case "K":
        case "P":
        case "p":
        case "z":
          return null;
        default:
          out += `\\${next}`;
          continue;
      }
    }

    if (ch === "(" && pattern.startsWith("(?:", i)) {
      out += "(";
      i += 2;
      continue;
    }

    if (ch === "(" && /^[(]\?<[^>]+>/.test(pattern.slice(i))) {
      const named = pattern.slice(i).match(/^\(\?<[^>]+>/);
      if (!named) return null;
      out += "(";
      i += named[0].length - 1;
      continue;
    }

    if (ch === "(" && pattern[i + 1] === "?") return null;

    out += ch;
  }

  return out;
}

function buildContentPredicate(
  column: string,
  likeOp: "LIKE" | "ILIKE",
  patterns: string[],
): string {
  if (patterns.length === 0) return "";
  if (patterns.length === 1) return `${column} ${likeOp} '%${patterns[0]}%'`;
  return `(${patterns.map((pattern) => `${column} ${likeOp} '%${pattern}%'`).join(" OR ")})`;
}

function buildRegexPredicate(
  column: string,
  pattern: string | undefined,
  ignoreCase: boolean,
): string {
  if (!pattern) return "";
  if (!isSqlRegexPushdownSafe(pattern)) return "";
  const sqlPattern = toSqlRegexPattern(pattern, ignoreCase);
  if (!sqlPattern) return "";
  return `${column} ~ '${sqlStr(sqlPattern)}'`;
}

function joinAndPredicates(predicates: string[]): string {
  const filtered = predicates.filter(Boolean);
  if (filtered.length === 0) return "";
  if (filtered.length === 1) return filtered[0]!;
  return `(${filtered.join(" AND ")})`;
}

function joinOrPredicates(predicates: string[]): string {
  const filtered = predicates.filter(Boolean);
  if (filtered.length === 0) return "";
  if (filtered.length === 1) return filtered[0]!;
  return `(${filtered.join(" OR ")})`;
}

function buildAnyColumnPredicate(
  columns: string[],
  builder: (column: string) => string,
): string {
  return joinOrPredicates(columns.map((column) => builder(column)));
}

function buildStructuredSessionFilter(
  likeOp: "LIKE" | "ILIKE",
  patterns: string[],
  regexPattern: string | undefined,
  ignoreCase: boolean,
): string {
  const typeExpr = "COALESCE(json_extract_string(message, '$.type'), '')";
  const contentExpr = "COALESCE(json_extract_string(message, '$.content'), '')";
  const toolFieldExprs = [
    "COALESCE(json_extract_string(message, '$.tool_name'), '')",
    "COALESCE(json_extract_string(message, '$.tool_input'), '')",
    "COALESCE(json_extract_string(message, '$.tool_response'), '')",
  ];
  const metaExprs = [
    typeExpr,
    "COALESCE(json_extract_string(message, '$.hook_event_name'), '')",
    "COALESCE(json_extract_string(message, '$.agent_type'), '')",
  ];

  const buildFieldSearch = (columns: string[]): string => joinAndPredicates([
    buildAnyColumnPredicate(columns, (column) => buildContentPredicate(column, likeOp, patterns)),
    buildAnyColumnPredicate(columns, (column) => buildRegexPredicate(column, regexPattern, ignoreCase)),
  ]);

  const contentSearch = buildFieldSearch([contentExpr]);
  const toolSearch = buildFieldSearch(toolFieldExprs);
  const metaSearch = buildFieldSearch(metaExprs);

  const branches = [
    contentSearch
      ? joinAndPredicates([`${typeExpr} IN ('user_message', 'assistant_message')`, contentSearch])
      : "",
    toolSearch
      ? joinAndPredicates([`${typeExpr} = 'tool_call'`, toolSearch])
      : "",
    metaSearch,
  ];

  const predicate = joinOrPredicates(branches);
  return predicate ? ` AND ${predicate}` : "";
}

// ── Regex refinement (line-by-line grep) ────────────────────────────────────

/** Compile the grep regex from params, with a safe fallback on bad user regex. */
export function compileGrepRegex(params: GrepMatchParams): RegExp {
  const normalizedPattern = params.fixedString ? params.pattern : normalizeGrepRegexPattern(params.pattern);
  let reStr = params.fixedString
    ? escapeRegexLiteral(normalizedPattern)
    : normalizedPattern;
  if (params.wordMatch) reStr = `\\b(?:${reStr})\\b`;
  try {
    return new RegExp(reStr, params.ignoreCase ? "i" : "");
  } catch {
    return new RegExp(
      escapeRegexLiteral(normalizedPattern),
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
  forceMultiFilePrefix?: boolean,
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
  return refineGrepMatches(normalized, params, forceMultiFilePrefix);
}
