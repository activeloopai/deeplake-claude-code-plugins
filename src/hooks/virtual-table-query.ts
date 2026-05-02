import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";
import { normalizeContent } from "../shell/grep-core.js";

type Row = Record<string, unknown>;

function normalizeSessionPart(path: string, content: string): string {
  return normalizeContent(path, content);
}

/**
 * Cap on rows rendered per section. A fully-populated workspace memory + a
 * fully-populated sessions table can produce tens of thousands of rows; the
 * resulting markdown blew past the Read-tool token budget (and the SQL ORDER
 * BY without LIMIT pulled the whole sessions table — ~MB-scale traffic per
 * SessionStart). 50 most-recent per section keeps the rendered file in
 * single-digit KB while covering the "what's recent" use case; older rows
 * remain reachable via Grep.
 */
export const INDEX_LIMIT_PER_SECTION = 50;

/**
 * Pure renderer for the virtual /index.md. Single source of truth shared by
 * the deeplake-shell REPL (src/shell/deeplake-fs.ts) and the pre-tool-use
 * hook path (readVirtualPathContents below). Both fetch their rows
 * separately — the shell from its DeeplakeFs cache flow, the hook one-shot
 * stateless — and pass them into this function for formatting.
 *
 * Each input row is expected to carry: path, project (memory only),
 * description, creation_date, last_update_date. Rows are rendered IN ORDER,
 * so the caller is responsible for the recency sort. `truncated*` flags
 * control whether the per-section "showing N most-recent of many" notice
 * is emitted above the table.
 */
export function buildVirtualIndexContent(
  summaryRows: Row[],
  sessionRows: Row[] = [],
  opts: { summaryTruncated?: boolean; sessionTruncated?: boolean } = {},
): string {
  const lines: string[] = [
    "# Session Index",
    "",
    "Two sources are available. Consult the section relevant to the question.",
    "",
  ];

  // ── ## memory ──────────────────────────────────────────────────────────────
  lines.push("## memory", "");
  if (summaryRows.length === 0) {
    lines.push("_(empty — no summaries ingested yet)_");
  } else {
    lines.push("AI-generated summaries per session. Read these first for topic-level overviews.");
    lines.push("");
    if (opts.summaryTruncated) {
      lines.push(`_Showing ${INDEX_LIMIT_PER_SECTION} most-recent of many — older summaries reachable via \`Grep pattern=\"...\" path=\"~/.deeplake/memory\"\`._`);
      lines.push("");
    }
    lines.push("| Session | Created | Last Updated | Project | Description |");
    lines.push("|---------|---------|--------------|---------|-------------|");
    for (const row of summaryRows) {
      const p = (row["path"] as string) || "";
      const match = p.match(/\/summaries\/([^/]+)\/([^/]+)\.md$/);
      if (!match) continue;
      const summaryUser = match[1];
      const sessionId = match[2];
      const relPath = `summaries/${summaryUser}/${sessionId}.md`;
      const project = (row["project"] as string) || "";
      const description = (row["description"] as string) || "";
      const creationDate = (row["creation_date"] as string) || "";
      const lastUpdateDate = (row["last_update_date"] as string) || "";
      lines.push(`| [${sessionId}](${relPath}) | ${creationDate} | ${lastUpdateDate} | ${project} | ${description} |`);
    }
  }
  lines.push("");

  // ── ## sessions ────────────────────────────────────────────────────────────
  lines.push("## sessions", "");
  if (sessionRows.length === 0) {
    lines.push("_(empty — no session records ingested yet)_");
  } else {
    lines.push("Raw session records (dialogue, tool calls). Read for exact detail / quotes.");
    lines.push("");
    if (opts.sessionTruncated) {
      lines.push(`_Showing ${INDEX_LIMIT_PER_SECTION} most-recent of many — older sessions reachable via \`Grep pattern=\"...\" path=\"~/.deeplake/memory\"\`._`);
      lines.push("");
    }
    lines.push("| Session | Created | Last Updated | Description |");
    lines.push("|---------|---------|--------------|-------------|");
    for (const row of sessionRows) {
      const p = (row["path"] as string) || "";
      const rel = p.startsWith("/") ? p.slice(1) : p;
      const filename = p.split("/").pop() ?? p;
      const description = (row["description"] as string) || "";
      const creationDate = (row["creation_date"] as string) || "";
      const lastUpdateDate = (row["last_update_date"] as string) || "";
      lines.push(`| [${filename}](${rel}) | ${creationDate} | ${lastUpdateDate} | ${description} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function buildUnionQuery(memoryQuery: string, sessionsQuery: string): string {
  return (
    `SELECT path, content, size_bytes, creation_date, source_order FROM (` +
    `(${memoryQuery}) UNION ALL (${sessionsQuery})` +
    `) AS combined ORDER BY path, source_order, creation_date`
  );
}

function buildInList(paths: string[]): string {
  return paths.map(path => `'${sqlStr(path)}'`).join(", ");
}

function buildDirFilter(dirs: string[]): string {
  const cleaned = [...new Set(dirs.map(dir => dir.replace(/\/+$/, "") || "/"))];
  if (cleaned.length === 0 || cleaned.includes("/")) return "";
  const clauses = cleaned.map((dir) => `path LIKE '${sqlLike(dir)}/%' ESCAPE '\\'`);
  return ` WHERE ${clauses.join(" OR ")}`;
}

async function queryUnionRows(
  api: DeeplakeApi,
  memoryQuery: string,
  sessionsQuery: string,
): Promise<Row[]> {
  const unionQuery = buildUnionQuery(memoryQuery, sessionsQuery);
  try {
    return await api.query(unionQuery);
  } catch {
    const [memoryRows, sessionRows] = await Promise.all([
      api.query(memoryQuery).catch(() => []),
      api.query(sessionsQuery).catch(() => []),
    ]);
    return [...memoryRows, ...sessionRows];
  }
}

export async function readVirtualPathContents(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  virtualPaths: string[],
): Promise<Map<string, string | null>> {
  const uniquePaths = [...new Set(virtualPaths)];
  const result = new Map<string, string | null>(uniquePaths.map(path => [path, null]));
  if (uniquePaths.length === 0) return result;

  const inList = buildInList(uniquePaths);
  const rows = await queryUnionRows(
    api,
    `SELECT path, summary::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}" WHERE path IN (${inList})`,
    `SELECT path, message::text AS content, NULL::bigint AS size_bytes, COALESCE(creation_date::text, '') AS creation_date, 1 AS source_order FROM "${sessionsTable}" WHERE path IN (${inList})`,
  );

  const memoryHits = new Map<string, string>();
  const sessionHits = new Map<string, string[]>();
  for (const row of rows) {
    const path = row["path"];
    const content = row["content"];
    const sourceOrder = Number(row["source_order"] ?? 0);
    if (typeof path !== "string" || typeof content !== "string") continue;
    if (sourceOrder === 0) {
      memoryHits.set(path, content);
    } else {
      const current = sessionHits.get(path) ?? [];
      current.push(normalizeSessionPart(path, content));
      sessionHits.set(path, current);
    }
  }

  for (const path of uniquePaths) {
    if (memoryHits.has(path)) {
      result.set(path, memoryHits.get(path) ?? null);
      continue;
    }
    const sessionParts = sessionHits.get(path) ?? [];
    if (sessionParts.length > 0) {
      result.set(path, sessionParts.join("\n"));
    }
  }

  if (result.get("/index.md") === null && uniquePaths.includes("/index.md")) {
    // Fetch one extra row beyond the cap so we can detect "more available"
    // and emit the truncation note. ORDER BY last_update_date DESC pulls the
    // most-recently-touched rows first; LIMIT bounds both DB cost and the
    // markdown size we hand back to CC's Read tool. The sessions query
    // aggregates per path because the sessions table stores one row per
    // event — without GROUP BY a single conversation appeared dozens of
    // times in the index.
    const fetchLimit = INDEX_LIMIT_PER_SECTION + 1;
    const [summaryRows, sessionRows] = await Promise.all([
      api.query(
        `SELECT path, project, description, creation_date, last_update_date FROM "${memoryTable}" ` +
        `WHERE path LIKE '/summaries/%' ORDER BY last_update_date DESC LIMIT ${fetchLimit}`
      ).catch(() => [] as Row[]),
      api.query(
        `SELECT path, MAX(description) AS description, MIN(creation_date) AS creation_date, MAX(last_update_date) AS last_update_date ` +
        `FROM "${sessionsTable}" WHERE path LIKE '/sessions/%' ` +
        `GROUP BY path ORDER BY MAX(last_update_date) DESC LIMIT ${fetchLimit}`
      ).catch(() => [] as Row[]),
    ]);
    const summaryTruncated = summaryRows.length > INDEX_LIMIT_PER_SECTION;
    const sessionTruncated = sessionRows.length > INDEX_LIMIT_PER_SECTION;
    result.set(
      "/index.md",
      buildVirtualIndexContent(
        summaryRows.slice(0, INDEX_LIMIT_PER_SECTION),
        sessionRows.slice(0, INDEX_LIMIT_PER_SECTION),
        { summaryTruncated, sessionTruncated },
      ),
    );
  }

  return result;
}

export async function listVirtualPathRowsForDirs(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  dirs: string[],
): Promise<Map<string, Row[]>> {
  const uniqueDirs = [...new Set(dirs.map(dir => dir.replace(/\/+$/, "") || "/"))];
  const filter = buildDirFilter(uniqueDirs);
  const rows = await queryUnionRows(
    api,
    `SELECT path, NULL::text AS content, size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}"${filter}`,
    `SELECT path, NULL::text AS content, size_bytes, '' AS creation_date, 1 AS source_order FROM "${sessionsTable}"${filter}`,
  );

  const deduped = dedupeRowsByPath(rows.map((row) => ({
    path: row["path"],
    size_bytes: row["size_bytes"],
  })));

  const byDir = new Map<string, Row[]>();
  for (const dir of uniqueDirs) byDir.set(dir, []);
  for (const row of deduped) {
    const path = row["path"];
    if (typeof path !== "string") continue;
    for (const dir of uniqueDirs) {
      const prefix = dir === "/" ? "/" : `${dir}/`;
      if (dir === "/" || path.startsWith(prefix)) {
        byDir.get(dir)?.push(row);
      }
    }
  }
  return byDir;
}

export async function readVirtualPathContent(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  virtualPath: string,
): Promise<string | null> {
  return (await readVirtualPathContents(api, memoryTable, sessionsTable, [virtualPath])).get(virtualPath) ?? null;
}

export async function listVirtualPathRows(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  dir: string,
): Promise<Row[]> {
  return (await listVirtualPathRowsForDirs(api, memoryTable, sessionsTable, [dir])).get(dir.replace(/\/+$/, "") || "/") ?? [];
}

export async function findVirtualPaths(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  dir: string,
  filenamePattern: string,
): Promise<string[]> {
  const normalizedDir = dir.replace(/\/+$/, "") || "/";
  const likePath = `${sqlLike(normalizedDir === "/" ? "" : normalizedDir)}/%`;
  const rows = await queryUnionRows(
    api,
    `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}" WHERE path LIKE '${likePath}' ESCAPE '\\' AND filename LIKE '${filenamePattern}' ESCAPE '\\'`,
    `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 1 AS source_order FROM "${sessionsTable}" WHERE path LIKE '${likePath}' ESCAPE '\\' AND filename LIKE '${filenamePattern}' ESCAPE '\\'`,
  );

  return [...new Set(
    rows
      .map(row => row["path"])
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
}

function dedupeRowsByPath(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const unique: Row[] = [];
  for (const row of rows) {
    const path = typeof row["path"] === "string" ? row["path"] : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(row);
  }
  return unique;
}
