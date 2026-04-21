import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";
import { type GrepParams, handleGrepDirect, parseBashGrep } from "./grep-direct.js";
import { normalizeContent, refineGrepMatches } from "../shell/grep-core.js";
import {
  listVirtualPathRowsForDirs,
  readVirtualPathContents,
  findVirtualPaths,
} from "./virtual-table-query.js";
import { isPsqlMode } from "../utils/retrieval-mode.js";

type VirtualRow = Record<string, unknown>;

export type CompiledSegment =
  | { kind: "echo"; text: string }
  | { kind: "cat"; paths: string[]; lineLimit: number; fromEnd: boolean; countLines: boolean; ignoreMissing: boolean }
  | { kind: "ls"; dirs: string[]; longFormat: boolean }
  | { kind: "find"; dir: string; pattern: string; countOnly: boolean }
  | { kind: "find_grep"; dir: string; patterns: string[]; params: GrepParams; lineLimit: number }
  | { kind: "psql"; query: string; lineLimit: number; tuplesOnly: boolean; fieldSeparator: string }
  | { kind: "grep"; params: GrepParams; lineLimit: number };

interface ParsedModifier {
  clean: string;
  ignoreMissing: boolean;
}

interface ParsedFindSpec {
  patterns: string[];
  execGrepCmd: string | null;
}

function isQuoted(ch: string): boolean {
  return ch === "'" || ch === "\"";
}

export function splitTopLevel(input: string, operators: string[]): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === "\"") escaped = true;
      current += ch;
      continue;
    }
    if (isQuoted(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += ch;
      escaped = true;
      continue;
    }

    const matched = operators.find((op) => input.startsWith(op, i));
    if (matched) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      i += matched.length - 1;
      continue;
    }

    current += ch;
  }

  if (quote || escaped) return null;
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export function tokenizeShellWords(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === "\"" && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (isQuoted(ch)) {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

export function expandBraceToken(token: string): string[] {
  const match = token.match(/\{([^{}]+)\}/);
  if (!match) return [token];

  const [expr] = match;
  const prefix = token.slice(0, match.index);
  const suffix = token.slice((match.index ?? 0) + expr.length);

  let variants: string[] = [];
  const numericRange = match[1].match(/^(-?\d+)\.\.(-?\d+)$/);
  if (numericRange) {
    const start = Number(numericRange[1]);
    const end = Number(numericRange[2]);
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      variants.push(String(value));
    }
  } else {
    variants = match[1].split(",");
  }

  return variants.flatMap((variant) => expandBraceToken(`${prefix}${variant}${suffix}`));
}

export function stripAllowedModifiers(segment: string): ParsedModifier {
  const ignoreMissing = /\s2>\/dev\/null(?=\s*(?:\||$))/.test(segment);
  const clean = segment
    .replace(/\s2>\/dev\/null(?=\s*(?:\||$))/g, "")
    .replace(/\s2>&1(?=\s*(?:\||$))/g, "")
    .trim();
  return { clean, ignoreMissing };
}

export function hasUnsupportedRedirection(segment: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuoted(ch)) {
      quote = ch;
      continue;
    }
    if (ch === ">" || ch === "<") return true;
  }
  return false;
}

function parseHeadTailStage(stage: string): { lineLimit: number; fromEnd: boolean } | null {
  const tokens = tokenizeShellWords(stage);
  if (!tokens || tokens.length === 0) return null;
  const [cmd, ...rest] = tokens;
  if (cmd !== "head" && cmd !== "tail") return null;
  if (rest.length === 0) return { lineLimit: 10, fromEnd: cmd === "tail" };
  if (rest.length === 1) {
    const count = Number(rest[0]);
    if (!Number.isFinite(count)) {
      return { lineLimit: 10, fromEnd: cmd === "tail" };
    }
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 2 && /^-\d+$/.test(rest[0])) {
    const count = Number(rest[0]);
    if (!Number.isFinite(count)) return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 2 && rest[0] === "-n") {
    const count = Number(rest[1]);
    if (!Number.isFinite(count)) return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  if (rest.length === 3 && rest[0] === "-n") {
    const count = Number(rest[1]);
    if (!Number.isFinite(count)) return null;
    return { lineLimit: Math.abs(count), fromEnd: cmd === "tail" };
  }
  return null;
}

function isValidPipelineHeadTailStage(stage: string): boolean {
  const tokens = tokenizeShellWords(stage);
  if (!tokens || (tokens[0] !== "head" && tokens[0] !== "tail")) return false;
  if (tokens.length === 1) return true;
  if (tokens.length === 2) return /^-\d+$/.test(tokens[1]);
  if (tokens.length === 3) return tokens[1] === "-n" && /^-?\d+$/.test(tokens[2]);
  return false;
}

function parseFindSpec(tokens: string[]): ParsedFindSpec | null {
  const patterns: string[] = [];
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-type") {
      i += 1;
      continue;
    }
    if (token === "-o") continue;
    if (token === "-name") {
      const pattern = tokens[i + 1];
      if (!pattern) return null;
      patterns.push(pattern);
      i += 1;
      continue;
    }
    if (token === "-exec") {
      const execTokens = tokens.slice(i + 1);
      if (patterns.length === 0 || execTokens.length < 4) return null;
      const terminator = execTokens.at(-1);
      const target = execTokens.at(-2);
      if ((terminator !== "\\;" && terminator !== ";") || target !== "{}") return null;
      return {
        patterns,
        execGrepCmd: execTokens.slice(0, -1).join(" "),
      };
    }
    return null;
  }
  return patterns.length > 0 ? { patterns, execGrepCmd: null } : null;
}

function extractPsqlQuery(tokens: string[]): string | null {
  let query: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-c" || token === "--command") {
      query = tokens[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      query = token.slice(2);
      continue;
    }
  }
  return query;
}

export function extractPsqlQueryFromCommand(cmd: string): string | null {
  const tokens = tokenizeShellWords(cmd.trim());
  if (!tokens || tokens[0] !== "psql") return null;
  return extractPsqlQuery(tokens);
}

function normalizeSqlRef(ref: string): string {
  return ref.replace(/\s+/g, "").replace(/"/g, "").toLowerCase();
}

const INTERCEPTED_SQL_REFS = new Set([
  "memory",
  "sessions",
  "graph_nodes",
  "graph_edges",
  "memory_facts",
  "memory_entities",
  "fact_entity_links",
  "hivemind.memory",
  "hivemind.sessions",
  "hivemind.graph_nodes",
  "hivemind.graph_edges",
  "hivemind.memory_facts",
  "hivemind.memory_entities",
  "hivemind.fact_entity_links",
]);

function extractSqlTableRefs(query: string): string[] {
  const refs: string[] = [];
  const regex = /\b(?:from|join)\s+((?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?)/gi;
  for (const match of query.matchAll(regex)) {
    if (match[1]) refs.push(normalizeSqlRef(match[1]));
  }
  return refs;
}

export function queryReferencesInterceptedTables(query: string): boolean {
  return extractSqlTableRefs(query).some((ref) => INTERCEPTED_SQL_REFS.has(ref));
}

export function queryUsesOnlyInterceptedTables(query: string): boolean {
  const refs = extractSqlTableRefs(query);
  return refs.length > 0 && refs.every((ref) => INTERCEPTED_SQL_REFS.has(ref));
}

export function queryUsesBareMemoryTables(query: string): boolean {
  return extractSqlTableRefs(query).some((ref) =>
    ref === "memory" ||
    ref === "sessions" ||
    ref === "graph_nodes" ||
    ref === "graph_edges" ||
    ref === "memory_facts" ||
    ref === "memory_entities" ||
    ref === "fact_entity_links");
}

function parsePsqlSegment(pipeline: string[], tokens: string[]): CompiledSegment | null {
  if (tokens[0] !== "psql" || !isPsqlMode()) return null;
  const query = extractPsqlQuery(tokens);
  let tuplesOnly = false;
  let fieldSeparator = "|";

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-F" || token === "--field-separator") {
      fieldSeparator = tokens[i + 1] ?? fieldSeparator;
      i += 1;
      continue;
    }
    if (token.startsWith("-F") && token.length > 2) {
      fieldSeparator = token.slice(2);
      continue;
    }
    if (token === "-t" || token === "--tuples-only") {
      tuplesOnly = true;
      continue;
    }
    if (token.startsWith("-") && !token.startsWith("--")) {
      const shortFlags = token.slice(1);
      if (shortFlags.includes("t")) tuplesOnly = true;
      continue;
    }
  }

  if (!query || !queryUsesOnlyInterceptedTables(query)) return null;

  let lineLimit = 0;
  if (pipeline.length > 1) {
    if (pipeline.length !== 2) return null;
    const headStage = pipeline[1].trim();
    if (!isValidPipelineHeadTailStage(headStage)) return null;
    const headTail = parseHeadTailStage(headStage);
    if (!headTail || headTail.fromEnd) return null;
    lineLimit = headTail.lineLimit;
  }

  return { kind: "psql", query, lineLimit, tuplesOnly, fieldSeparator };
}

function normalizePsqlQuery(
  query: string,
  memoryTable: string,
  sessionsTable: string,
  graphNodesTable = process.env["HIVEMIND_GRAPH_NODES_TABLE"] ?? "graph_nodes",
  graphEdgesTable = process.env["HIVEMIND_GRAPH_EDGES_TABLE"] ?? "graph_edges",
  factsTable = process.env["HIVEMIND_FACTS_TABLE"] ?? "memory_facts",
  entitiesTable = process.env["HIVEMIND_ENTITIES_TABLE"] ?? "memory_entities",
  factEntityLinksTable = process.env["HIVEMIND_FACT_ENTITY_LINKS_TABLE"] ?? "fact_entity_links",
): string {
  let sql = query.trim().replace(/;+\s*$/, "");
  sql = sql
    .replace(/\bFROM\s+"?memory"?\b/gi, `FROM "${memoryTable}"`)
    .replace(/\bJOIN\s+"?memory"?\b/gi, `JOIN "${memoryTable}"`)
    .replace(/\bFROM\s+"?sessions"?\b/gi, `FROM "${sessionsTable}"`)
    .replace(/\bJOIN\s+"?sessions"?\b/gi, `JOIN "${sessionsTable}"`)
    .replace(/\bFROM\s+"?graph_nodes"?\b/gi, `FROM "${graphNodesTable}"`)
    .replace(/\bJOIN\s+"?graph_nodes"?\b/gi, `JOIN "${graphNodesTable}"`)
    .replace(/\bFROM\s+"?graph_edges"?\b/gi, `FROM "${graphEdgesTable}"`)
    .replace(/\bJOIN\s+"?graph_edges"?\b/gi, `JOIN "${graphEdgesTable}"`)
    .replace(/\bFROM\s+"?memory_facts"?\b/gi, `FROM "${factsTable}"`)
    .replace(/\bJOIN\s+"?memory_facts"?\b/gi, `JOIN "${factsTable}"`)
    .replace(/\bFROM\s+"?memory_entities"?\b/gi, `FROM "${entitiesTable}"`)
    .replace(/\bJOIN\s+"?memory_entities"?\b/gi, `JOIN "${entitiesTable}"`)
    .replace(/\bFROM\s+"?fact_entity_links"?\b/gi, `FROM "${factEntityLinksTable}"`)
    .replace(/\bJOIN\s+"?fact_entity_links"?\b/gi, `JOIN "${factEntityLinksTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?memory"?\b/gi, `FROM "${memoryTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?memory"?\b/gi, `JOIN "${memoryTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?sessions"?\b/gi, `FROM "${sessionsTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?sessions"?\b/gi, `JOIN "${sessionsTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?graph_nodes"?\b/gi, `FROM "${graphNodesTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?graph_nodes"?\b/gi, `JOIN "${graphNodesTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?graph_edges"?\b/gi, `FROM "${graphEdgesTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?graph_edges"?\b/gi, `JOIN "${graphEdgesTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?memory_facts"?\b/gi, `FROM "${factsTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?memory_facts"?\b/gi, `JOIN "${factsTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?memory_entities"?\b/gi, `FROM "${entitiesTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?memory_entities"?\b/gi, `JOIN "${entitiesTable}"`)
    .replace(/\bFROM\s+"?hivemind"?\."?fact_entity_links"?\b/gi, `FROM "${factEntityLinksTable}"`)
    .replace(/\bJOIN\s+"?hivemind"?\."?fact_entity_links"?\b/gi, `JOIN "${factEntityLinksTable}"`);
  return sql;
}

function validatePsqlQuery(
  query: string,
  memoryTable: string,
  sessionsTable: string,
  graphNodesTable = process.env["HIVEMIND_GRAPH_NODES_TABLE"] ?? "graph_nodes",
  graphEdgesTable = process.env["HIVEMIND_GRAPH_EDGES_TABLE"] ?? "graph_edges",
  factsTable = process.env["HIVEMIND_FACTS_TABLE"] ?? "memory_facts",
  entitiesTable = process.env["HIVEMIND_ENTITIES_TABLE"] ?? "memory_entities",
  factEntityLinksTable = process.env["HIVEMIND_FACT_ENTITY_LINKS_TABLE"] ?? "fact_entity_links",
): string {
  if (!queryUsesOnlyInterceptedTables(query)) {
    throw new Error("psql queries must reference only memory, sessions, graph_nodes, graph_edges, memory_facts, memory_entities, fact_entity_links, or their hivemind.* aliases");
  }
  const sql = normalizePsqlQuery(
    query,
    memoryTable,
    sessionsTable,
    graphNodesTable,
    graphEdgesTable,
    factsTable,
    entitiesTable,
    factEntityLinksTable,
  );
  const compact = sql.replace(/\s+/g, " ").trim();
  if (!/^(select|with)\b/i.test(compact)) {
    throw new Error("psql mode only supports SELECT queries");
  }
  const allowedTables = new Set([
    memoryTable,
    sessionsTable,
    graphNodesTable,
    graphEdgesTable,
    factsTable,
    entitiesTable,
    factEntityLinksTable,
  ]);
  const tableMatches = [...compact.matchAll(/\b(?:from|join)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)];
  if (tableMatches.length === 0) {
    throw new Error("psql query must reference an intercepted hivemind memory table");
  }
  for (const match of tableMatches) {
    if (!allowedTables.has(match[1])) {
      throw new Error(`psql query references unsupported table: ${match[1]}`);
    }
  }
  return sql;
}

function decodeSqlLiteral(value: string): string {
  return value.replace(/''/g, "'").trim();
}

function cleanSearchTerm(value: string): string {
  return decodeSqlLiteral(value)
    .replace(/^%+|%+$/g, "")
    .replace(/^_+|_+$/g, "")
    .trim();
}

function extractSqlSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const push = (value: string) => {
    const cleaned = cleanSearchTerm(value);
    if (!cleaned) return;
    if (cleaned.startsWith("/")) return;
    if (/^\/summaries\/|^\/sessions\//.test(cleaned)) return;
    if (!terms.includes(cleaned)) terms.push(cleaned);
  };

  for (const match of query.matchAll(/\b(?:i?like|=)\s+E?'((?:[^']|'')*)'/gi)) {
    push(match[1] ?? "");
  }
  for (const match of query.matchAll(/<\#>\s+E?'((?:[^']|'')*)'/gi)) {
    push(match[1] ?? "");
  }
  return terms;
}

function chooseEntityTerms(terms: string[]): string[] {
  const entityLike = terms.filter((term) =>
    /[A-Z]/.test(term) &&
    !/^\d+$/.test(term) &&
    term.split(/\s+/).length <= 4
  );
  return (entityLike.length > 0 ? entityLike : terms).slice(0, 2);
}

interface GraphCandidateRow extends VirtualRow {
  source_session_id?: string;
  source_path?: string;
  search_text?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchGraphCandidates(
  api: DeeplakeApi,
  graphNodesTable: string,
  graphEdgesTable: string,
  terms: string[],
): Promise<{ sessionId: string; sourcePath: string }[]> {
  const filteredTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, 4);
  if (filteredTerms.length === 0) return [];

  const entityTerms = chooseEntityTerms(filteredTerms);
  const topicTerms = filteredTerms.filter((term) => !entityTerms.includes(term));
  const phrase = sqlStr(filteredTerms.join(" "));
  const nodeEntityClauses = entityTerms.map((term) =>
    `(canonical_name ILIKE '%${sqlLike(term)}%' OR aliases ILIKE '%${sqlLike(term)}%')`
  );
  const nodeTextClauses = topicTerms.map((term) =>
    `search_text ILIKE '%${sqlLike(term)}%'`
  );
  const edgeEntityClauses = entityTerms.map((term) =>
    `search_text ILIKE '%${sqlLike(term)}%'`
  );
  const edgeTopicClauses = topicTerms.map((term) =>
    `(relation ILIKE '%${sqlLike(term)}%' OR summary ILIKE '%${sqlLike(term)}%' OR evidence ILIKE '%${sqlLike(term)}%' OR search_text ILIKE '%${sqlLike(term)}%')`
  );
  const nodeWhere = entityTerms.length > 0 && topicTerms.length > 0
    ? `(${nodeEntityClauses.join(" OR ")}) AND (${nodeTextClauses.join(" OR ")})`
    : entityTerms.length > 0
      ? `(${nodeEntityClauses.join(" OR ")})`
      : topicTerms.length > 0
        ? `(${nodeTextClauses.join(" OR ")})`
        : "FALSE";
  const edgeWhere = entityTerms.length > 0 && topicTerms.length > 0
    ? `(${edgeEntityClauses.join(" OR ")}) AND (${edgeTopicClauses.join(" OR ")})`
    : topicTerms.length > 0
      ? `(${edgeTopicClauses.join(" OR ")})`
      : entityTerms.length > 0
        ? `(${edgeEntityClauses.join(" OR ")})`
        : "FALSE";

  const sql =
    `WITH node_candidates AS (` +
    ` SELECT source_session_id, source_path, search_text, search_text <#> '${phrase}' AS score` +
    ` FROM "${graphNodesTable}"` +
    ` WHERE ${nodeWhere}` +
    ` ORDER BY score DESC LIMIT 8` +
    `), edge_candidates AS (` +
    ` SELECT source_session_id, source_path, search_text, search_text <#> '${phrase}' AS score` +
    ` FROM "${graphEdgesTable}"` +
    ` WHERE ${edgeWhere}` +
    ` ORDER BY score DESC LIMIT 8` +
    `)` +
    ` SELECT source_session_id, source_path, search_text, score` +
    ` FROM (` +
    `   SELECT source_session_id, source_path, search_text, score FROM node_candidates` +
    `   UNION ALL` +
    `   SELECT source_session_id, source_path, search_text, score FROM edge_candidates` +
    ` ) AS graph_candidates` +
    ` ORDER BY score ASC` +
    ` LIMIT 12`;

  const rows = await api.query(sql) as GraphCandidateRow[];
  const expanded: Array<{ sessionId: string; sourcePath: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const searchText = typeof row["search_text"] === "string" ? row["search_text"] : "";
    const sessionIds = [
      ...(searchText.match(/conv_\d+_session_\d+/g) ?? []),
      typeof row["source_session_id"] === "string" ? row["source_session_id"] : "",
    ].map((value) => value.trim()).filter(Boolean);
    const sourcePaths = [
      ...(searchText.match(/\/sessions\/conv_\d+_session_\d+\.json/g) ?? []),
      typeof row["source_path"] === "string" ? row["source_path"] : "",
      ...sessionIds.map((sessionId) => `/sessions/${sessionId}.json`),
    ].map((value) => value.trim()).filter(Boolean);
    for (let i = 0; i < sourcePaths.length; i++) {
      const sourcePath = sourcePaths[i];
      const sessionId = sessionIds[i] || sessionIds[0] || sourcePath.match(/(conv_\d+_session_\d+)\.json$/)?.[1] || "";
      if (!sourcePath) continue;
      const key = `${sessionId}@@${sourcePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push({ sessionId, sourcePath });
      if (expanded.length >= 12) return expanded;
    }
  }
  return expanded;
}

function prependCtes(sql: string, ctes: string[]): string {
  if (ctes.length === 0) return sql;
  if (/^with\b/i.test(sql)) {
    return sql.replace(/^with\b/i, `WITH ${ctes.join(", ")},`);
  }
  return `WITH ${ctes.join(", ")} ${sql}`;
}

function rewriteQueryWithRestrictedTables(
  sql: string,
  memoryTable: string,
  sessionsTable: string,
  restrictedMemoryAlias: string | null,
  restrictedSessionsAlias: string | null,
): string {
  let rewritten = sql;
  if (restrictedMemoryAlias) {
    const memoryPattern = escapeRegex(memoryTable);
    rewritten = rewritten
      .replace(new RegExp(`\\bFROM\\s+"?${memoryPattern}"?`, "gi"), `FROM "${restrictedMemoryAlias}"`)
      .replace(new RegExp(`\\bJOIN\\s+"?${memoryPattern}"?`, "gi"), `JOIN "${restrictedMemoryAlias}"`);
  }
  if (restrictedSessionsAlias) {
    const sessionsPattern = escapeRegex(sessionsTable);
    rewritten = rewritten
      .replace(new RegExp(`\\bFROM\\s+"?${sessionsPattern}"?`, "gi"), `FROM "${restrictedSessionsAlias}"`)
      .replace(new RegExp(`\\bJOIN\\s+"?${sessionsPattern}"?`, "gi"), `JOIN "${restrictedSessionsAlias}"`);
  }
  return rewritten;
}

async function applyGraphRestrictionsToPsqlQuery(
  api: DeeplakeApi,
  sql: string,
  memoryTable: string,
  sessionsTable: string,
  graphNodesTable: string,
  graphEdgesTable: string,
): Promise<string> {
  if (extractSqlTableRefs(sql).some((ref) => ref === normalizeSqlRef(graphNodesTable) || ref === normalizeSqlRef(graphEdgesTable))) {
    return sql;
  }
  const refs = extractSqlTableRefs(sql);
  const touchesMemory = refs.some((ref) => ref === normalizeSqlRef(memoryTable));
  const touchesSessions = refs.some((ref) => ref === normalizeSqlRef(sessionsTable));
  if (!touchesMemory && !touchesSessions) return sql;

  const terms = extractSqlSearchTerms(sql);
  if (terms.length === 0) return sql;

  const candidates = await fetchGraphCandidates(api, graphNodesTable, graphEdgesTable, terms);
  if (candidates.length === 0 || candidates.length > 16) return sql;

  const values = candidates.map((candidate) =>
    `('${sqlStr(candidate.sessionId)}', '${sqlStr(candidate.sourcePath)}')`
  );
  const ctes = [
    `__hm_graph_candidates(source_session_id, source_path) AS (VALUES ${values.join(", ")})`,
  ];
  let restrictedMemoryAlias: string | null = null;
  let restrictedSessionsAlias: string | null = null;

  if (touchesMemory) {
    restrictedMemoryAlias = "__hm_memory";
    ctes.push(
      `"${restrictedMemoryAlias}" AS (` +
      ` SELECT * FROM "${memoryTable}" m` +
      ` WHERE EXISTS (` +
      `   SELECT 1 FROM __hm_graph_candidates gc` +
      `   WHERE (gc.source_path <> '' AND m.summary ILIKE '%' || gc.source_path || '%')` +
      `      OR (gc.source_session_id <> '' AND m.path ILIKE '%' || gc.source_session_id || '%')` +
      ` )` +
      `)`
    );
  }
  if (touchesSessions) {
    restrictedSessionsAlias = "__hm_sessions";
    ctes.push(
      `"${restrictedSessionsAlias}" AS (` +
      ` SELECT * FROM "${sessionsTable}" s` +
      ` WHERE s.path IN (SELECT source_path FROM __hm_graph_candidates WHERE source_path <> '')` +
      `)`
    );
  }

  return prependCtes(
    rewriteQueryWithRestrictedTables(sql, memoryTable, sessionsTable, restrictedMemoryAlias, restrictedSessionsAlias),
    ctes,
  );
}

function formatPsqlValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatPsqlRows(
  rows: VirtualRow[],
  tuplesOnly: boolean,
  fieldSeparator: string,
): string {
  if (rows.length === 0) return tuplesOnly ? "" : "(0 rows)";
  const columns = Object.keys(rows[0] ?? {});
  const body = rows.map((row) => columns.map((column) => formatPsqlValue(row[column])).join(fieldSeparator));
  if (tuplesOnly) return body.join("\n");
  return [columns.join(fieldSeparator), ...body].join("\n");
}

export function parseCompiledSegment(segment: string): CompiledSegment | null {
  const { clean, ignoreMissing } = stripAllowedModifiers(segment);
  if (hasUnsupportedRedirection(clean)) return null;
  const pipeline = splitTopLevel(clean, ["|"]);
  if (!pipeline || pipeline.length === 0) return null;

  const tokens = tokenizeShellWords(pipeline[0]);
  if (!tokens || tokens.length === 0) return null;

  const psqlSegment = parsePsqlSegment(pipeline, tokens);
  if (psqlSegment) return psqlSegment;

  if (tokens[0] === "echo" && pipeline.length === 1) {
    const text = tokens.slice(1).join(" ");
    return { kind: "echo", text };
  }

  if (tokens[0] === "cat") {
    const paths = tokens.slice(1).flatMap(expandBraceToken);
    if (paths.length === 0) return null;
    let lineLimit = 0;
    let fromEnd = false;
    let countLines = false;
    if (pipeline.length > 1) {
      if (pipeline.length !== 2) return null;
      const pipeStage = pipeline[1].trim();
      if (/^wc\s+-l\s*$/.test(pipeStage)) {
        if (paths.length !== 1) return null;
        countLines = true;
      } else {
        if (!isValidPipelineHeadTailStage(pipeStage)) return null;
        const headTail = parseHeadTailStage(pipeStage);
        if (!headTail) return null;
        lineLimit = headTail.lineLimit;
        fromEnd = headTail.fromEnd;
      }
    }
    return { kind: "cat", paths, lineLimit, fromEnd, countLines, ignoreMissing };
  }

  if (tokens[0] === "head" || tokens[0] === "tail") {
    if (pipeline.length !== 1) return null;
    const parsed = parseHeadTailStage(clean);
    if (!parsed) return null;
    const headTokens = tokenizeShellWords(clean);
    if (!headTokens) return null;
    if (
      (headTokens[1] === "-n" && headTokens.length < 4) ||
      (/^-\d+$/.test(headTokens[1] ?? "") && headTokens.length < 3) ||
      (headTokens.length === 2 && /^-?\d+$/.test(headTokens[1] ?? ""))
    ) return null;
    const path = headTokens[headTokens.length - 1];
    if (path === "head" || path === "tail" || path === "-n") return null;
    return {
      kind: "cat",
      paths: expandBraceToken(path),
      lineLimit: parsed.lineLimit,
      fromEnd: parsed.fromEnd,
      countLines: false,
      ignoreMissing,
    };
  }

  if (tokens[0] === "wc" && tokens[1] === "-l" && pipeline.length === 1 && tokens[2]) {
    return {
      kind: "cat",
      paths: expandBraceToken(tokens[2]),
      lineLimit: 0,
      fromEnd: false,
      countLines: true,
      ignoreMissing,
    };
  }

  if (tokens[0] === "ls" && pipeline.length === 1) {
    const dirs = tokens
      .slice(1)
      .filter(token => !token.startsWith("-"))
      .flatMap(expandBraceToken);
    const longFormat = tokens.some(token => token.startsWith("-") && token.includes("l"));
    return { kind: "ls", dirs: dirs.length > 0 ? dirs : ["/"], longFormat };
  }

  if (tokens[0] === "find") {
    if (pipeline.length > 3) return null;
    const dir = tokens[1];
    if (!dir) return null;
    const spec = parseFindSpec(tokens);
    if (!spec) return null;
    const { patterns, execGrepCmd } = spec;
    const countOnly = pipeline.length === 2 && /^wc\s+-l\s*$/.test(pipeline[1].trim());
    if (countOnly) {
      if (patterns.length !== 1) return null;
      return { kind: "find", dir, pattern: patterns[0], countOnly };
    }

    if (execGrepCmd) {
      const grepParams = parseBashGrep(execGrepCmd);
      if (!grepParams) return null;
      let lineLimit = 0;
      if (pipeline.length === 2) {
        const headStage = pipeline[1].trim();
        if (!isValidPipelineHeadTailStage(headStage)) return null;
        const headTail = parseHeadTailStage(headStage);
        if (!headTail || headTail.fromEnd) return null;
        lineLimit = headTail.lineLimit;
      }
      return { kind: "find_grep", dir, patterns, params: grepParams, lineLimit };
    }

    if (pipeline.length >= 2) {
      const xargsTokens = tokenizeShellWords(pipeline[1].trim());
      if (!xargsTokens || xargsTokens[0] !== "xargs") return null;
      const xargsArgs = xargsTokens.slice(1);
      while (xargsArgs[0] && xargsArgs[0].startsWith("-")) {
        if (xargsArgs[0] === "-r") {
          xargsArgs.shift();
          continue;
        }
        return null;
      }
      const grepCmd = xargsArgs.join(" ");
      const grepParams = parseBashGrep(grepCmd);
      if (!grepParams) return null;
      let lineLimit = 0;
      if (pipeline.length === 3) {
        const headStage = pipeline[2].trim();
        if (!isValidPipelineHeadTailStage(headStage)) return null;
        const headTail = parseHeadTailStage(headStage);
        if (!headTail || headTail.fromEnd) return null;
        lineLimit = headTail.lineLimit;
      }
      return { kind: "find_grep", dir, patterns, params: grepParams, lineLimit };
    }

    if (patterns.length !== 1) return null;
    return { kind: "find", dir, pattern: patterns[0], countOnly };
  }

  const grepParams = parseBashGrep(clean);
  if (grepParams) {
    let lineLimit = 0;
    if (pipeline.length > 1) {
      if (pipeline.length !== 2) return null;
      const headStage = pipeline[1].trim();
      if (!isValidPipelineHeadTailStage(headStage)) return null;
      const headTail = parseHeadTailStage(headStage);
      if (!headTail || headTail.fromEnd) return null;
      lineLimit = headTail.lineLimit;
    }
    return { kind: "grep", params: grepParams, lineLimit };
  }

  return null;
}

export function parseCompiledBashCommand(cmd: string): CompiledSegment[] | null {
  if (cmd.includes("||")) return null;
  const segments = splitTopLevel(cmd, ["&&", ";", "\n"]);
  if (!segments || segments.length === 0) return null;
  const parsed = segments.map(parseCompiledSegment);
  if (parsed.some((segment) => segment === null)) return null;
  return parsed as CompiledSegment[];
}

function applyLineWindow(content: string, lineLimit: number, fromEnd: boolean): string {
  if (lineLimit <= 0) return content;
  const lines = content.split("\n");
  return (fromEnd ? lines.slice(-lineLimit) : lines.slice(0, lineLimit)).join("\n");
}

function countLines(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

function renderDirectoryListing(dir: string, rows: VirtualRow[], longFormat: boolean): string {
  const entries = new Map<string, { isDir: boolean; size: number }>();
  const prefix = dir === "/" ? "/" : `${dir}/`;
  for (const row of rows) {
    const path = row["path"] as string;
    if (!path.startsWith(prefix) && dir !== "/") continue;
    const rest = dir === "/" ? path.slice(1) : path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (!name) continue;
    const existing = entries.get(name);
    if (slash !== -1) {
      if (!existing) entries.set(name, { isDir: true, size: 0 });
    } else {
      entries.set(name, { isDir: false, size: Number(row["size_bytes"] ?? 0) });
    }
  }
  if (entries.size === 0) return `ls: cannot access '${dir}': No such file or directory`;

  const lines: string[] = [];
  for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (longFormat) {
      const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
      const size = String(info.isDir ? 0 : info.size).padStart(6);
      lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
    } else {
      lines.push(name + (info.isDir ? "/" : ""));
    }
  }
  return lines.join("\n");
}

interface ExecuteCompiledBashDeps {
  readVirtualPathContentsFn?: typeof readVirtualPathContents;
  listVirtualPathRowsForDirsFn?: typeof listVirtualPathRowsForDirs;
  findVirtualPathsFn?: typeof findVirtualPaths;
  handleGrepDirectFn?: typeof handleGrepDirect;
}

export async function executeCompiledBashCommand(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  cmd: string,
  deps: ExecuteCompiledBashDeps = {},
): Promise<string | null> {
  const {
    readVirtualPathContentsFn = readVirtualPathContents,
    listVirtualPathRowsForDirsFn = listVirtualPathRowsForDirs,
    findVirtualPathsFn = findVirtualPaths,
    handleGrepDirectFn = handleGrepDirect,
  } = deps;

  const plan = parseCompiledBashCommand(cmd);
  if (!plan) return null;

  const readPaths = [...new Set(plan.flatMap((segment) => segment.kind === "cat" ? segment.paths : []))];
  const listDirs = [...new Set(plan.flatMap((segment) => segment.kind === "ls" ? segment.dirs.map(dir => dir.replace(/\/+$/, "") || "/") : []))];

  const contentMap = readPaths.length > 0
    ? await readVirtualPathContentsFn(api, memoryTable, sessionsTable, readPaths)
    : new Map<string, string | null>();
  const dirRowsMap = listDirs.length > 0
    ? await listVirtualPathRowsForDirsFn(api, memoryTable, sessionsTable, listDirs)
    : new Map<string, VirtualRow[]>();

  const outputs: string[] = [];
  for (const segment of plan) {
    if (segment.kind === "echo") {
      outputs.push(segment.text);
      continue;
    }

    if (segment.kind === "cat") {
      const contents: string[] = [];
      for (const path of segment.paths) {
        const content = contentMap.get(path) ?? null;
        if (content === null) {
          if (segment.ignoreMissing) continue;
          return null;
        }
        contents.push(content);
      }
      const combined = contents.join("");
      if (segment.countLines) {
        outputs.push(`${countLines(combined)} ${segment.paths[0]}`);
      } else {
        outputs.push(applyLineWindow(combined, segment.lineLimit, segment.fromEnd));
      }
      continue;
    }

    if (segment.kind === "ls") {
      for (const dir of segment.dirs) {
        outputs.push(renderDirectoryListing(dir.replace(/\/+$/, "") || "/", dirRowsMap.get(dir.replace(/\/+$/, "") || "/") ?? [], segment.longFormat));
      }
      continue;
    }

    if (segment.kind === "find") {
      const filenamePattern = sqlLike(segment.pattern).replace(/\*/g, "%").replace(/\?/g, "_");
      const paths = await findVirtualPathsFn(api, memoryTable, sessionsTable, segment.dir.replace(/\/+$/, "") || "/", filenamePattern);
      outputs.push(segment.countOnly ? String(paths.length) : (paths.join("\n") || "(no matches)"));
      continue;
    }

    if (segment.kind === "find_grep") {
      const dir = segment.dir.replace(/\/+$/, "") || "/";
      const candidateBatches = await Promise.all(
        segment.patterns.map((pattern) =>
          findVirtualPathsFn(
            api,
            memoryTable,
            sessionsTable,
            dir,
            sqlLike(pattern).replace(/\*/g, "%").replace(/\?/g, "_"),
          ),
        ),
      );
      const candidatePaths = [...new Set(candidateBatches.flat())];
      if (candidatePaths.length === 0) {
        outputs.push("(no matches)");
        continue;
      }
      const candidateContents = await readVirtualPathContentsFn(api, memoryTable, sessionsTable, candidatePaths);
      const matched = refineGrepMatches(
        candidatePaths.flatMap((path) => {
          const content = candidateContents.get(path);
          if (content === null || content === undefined) return [];
          return [{ path, content: normalizeContent(path, content) }];
        }),
        segment.params,
      );
      const limited = segment.lineLimit > 0 ? matched.slice(0, segment.lineLimit) : matched;
      outputs.push(limited.join("\n") || "(no matches)");
      continue;
    }

    if (segment.kind === "psql") {
      const graphNodesTable = process.env["HIVEMIND_GRAPH_NODES_TABLE"] ?? "graph_nodes";
      const graphEdgesTable = process.env["HIVEMIND_GRAPH_EDGES_TABLE"] ?? "graph_edges";
      const validated = validatePsqlQuery(segment.query, memoryTable, sessionsTable, graphNodesTable, graphEdgesTable);
      const prepared = await applyGraphRestrictionsToPsqlQuery(
        api,
        validated,
        memoryTable,
        sessionsTable,
        graphNodesTable,
        graphEdgesTable,
      );
      const rows = await api.query(prepared);
      const formatted = formatPsqlRows(rows, segment.tuplesOnly, segment.fieldSeparator);
      const limited = segment.lineLimit > 0 ? formatted.split("\n").slice(0, segment.lineLimit).join("\n") : formatted;
      outputs.push(limited);
      continue;
    }

    if (segment.kind === "grep") {
      const result = await handleGrepDirectFn(api, memoryTable, sessionsTable, segment.params);
      if (result === null) return null;
      if (segment.lineLimit > 0) {
        outputs.push(result.split("\n").slice(0, segment.lineLimit).join("\n"));
      } else {
        outputs.push(result);
      }
      continue;
    }
  }

  return outputs.join("\n");
}
