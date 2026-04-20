import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";
import { normalizeContent } from "../shell/grep-core.js";
import { isIndexDisabled, isSessionsOnlyMode } from "../utils/retrieval-mode.js";
import { buildSummaryIndexEntry, buildSummaryIndexLine, type SummaryIndexEntry } from "../utils/summary-format.js";

type Row = Record<string, unknown>;

function normalizeSessionPart(path: string, content: string): string {
  return normalizeContent(path, content);
}

export function buildVirtualIndexContent(rows: Row[]): string {
  const entries = rows
    .map((row) => buildSummaryIndexEntry(row))
    .filter((entry): entry is SummaryIndexEntry => entry !== null)
    .sort((a, b) => (b.sortDate || "").localeCompare(a.sortDate || "") || a.path.localeCompare(b.path));

  const lines = [
    "# Memory Index",
    "",
    "Persistent wiki directory. Start here, open the linked summary first, then open the paired raw session if you need exact wording or temporal grounding.",
    "",
    "## How To Use",
    "",
    "- Use the People section when the question names a person.",
    "- In the catalog, each row links to both the summary page and its source session.",
    "- Once you have a likely match, open that exact summary or session instead of broadening into wide grep scans.",
    "",
  ];

  const peopleLines = buildPeopleDirectory(entries);
  if (peopleLines.length > 0) {
    lines.push("## People");
    lines.push("");
    lines.push(...peopleLines);
    lines.push("");
  }

  const projectLines = buildProjectDirectory(entries);
  if (projectLines.length > 0) {
    lines.push("## Projects");
    lines.push("");
    lines.push(...projectLines);
    lines.push("");
  }

  lines.push("## Summary To Session Catalog");
  lines.push("");
  for (const entry of entries) {
    const line = buildSummaryIndexLine(entry);
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

function formatEntryLink(entry: SummaryIndexEntry): string {
  const session = entry.source ? ` -> [session](${entry.source})` : "";
  return `[${entry.label}](${entry.path})${session}`;
}

function topList(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function buildPeopleDirectory(entries: SummaryIndexEntry[]): string[] {
  const people = new Map<string, { count: number; topics: Map<string, number>; recent: SummaryIndexEntry[] }>();

  for (const entry of entries) {
    for (const person of entry.participants) {
      const current = people.get(person) ?? { count: 0, topics: new Map<string, number>(), recent: [] };
      current.count += 1;
      for (const topic of entry.topics) {
        current.topics.set(topic, (current.topics.get(topic) ?? 0) + 1);
      }
      current.recent.push(entry);
      people.set(person, current);
    }
  }

  return [...people.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([person, info]) => {
      const topics = topList(info.topics, 3);
      const recent = info.recent.slice(0, 2).map((entry) => formatEntryLink(entry)).join(", ");
      const parts = [`- ${person} — ${info.count} summaries`];
      if (topics.length > 0) parts.push(`topics: ${topics.join("; ")}`);
      if (recent) parts.push(`recent: ${recent}`);
      return parts.join(" — ");
    });
}

function buildProjectDirectory(entries: SummaryIndexEntry[]): string[] {
  const projects = new Map<string, { count: number; recent: SummaryIndexEntry[] }>();

  for (const entry of entries) {
    if (!entry.project) continue;
    const current = projects.get(entry.project) ?? { count: 0, recent: [] };
    current.count += 1;
    current.recent.push(entry);
    projects.set(entry.project, current);
  }

  return [...projects.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([project, info]) => {
      const recent = info.recent.slice(0, 2).map((entry) => formatEntryLink(entry)).join(", ");
      const parts = [`- ${project} — ${info.count} summaries`];
      if (recent) parts.push(`recent: ${recent}`);
      return parts.join(" — ");
    });
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
  const clauses = cleaned.map((dir) => `path LIKE '${sqlLike(dir)}/%'`);
  return ` WHERE ${clauses.join(" OR ")}`;
}

async function queryUnionRows(
  api: DeeplakeApi,
  memoryQuery: string,
  sessionsQuery: string,
): Promise<Row[]> {
  if (isSessionsOnlyMode()) {
    return api.query(
      `SELECT path, content, size_bytes, creation_date, source_order FROM (${sessionsQuery}) AS combined ORDER BY path, source_order, creation_date`
    );
  }

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
  if (isIndexDisabled() && uniquePaths.includes("/index.md")) {
    result.set("/index.md", null);
  }

  const queryPaths = isIndexDisabled()
    ? uniquePaths.filter((path) => path !== "/index.md")
    : uniquePaths;
  if (queryPaths.length === 0) return result;

  const inList = buildInList(queryPaths);
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

  for (const path of queryPaths) {
    if (memoryHits.has(path)) {
      result.set(path, memoryHits.get(path) ?? null);
      continue;
    }
    const sessionParts = sessionHits.get(path) ?? [];
    if (sessionParts.length > 0) {
      result.set(path, sessionParts.join("\n"));
    }
  }

  if (!isSessionsOnlyMode() && !isIndexDisabled() && result.get("/index.md") === null && uniquePaths.includes("/index.md")) {
    const rows = await api.query(
      `SELECT path, project, description, summary, creation_date, last_update_date FROM "${memoryTable}" WHERE path LIKE '/summaries/%' ORDER BY last_update_date DESC, creation_date DESC`
    ).catch(() => []);
    result.set("/index.md", buildVirtualIndexContent(rows));
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
    `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 0 AS source_order FROM "${memoryTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}'`,
    `SELECT path, NULL::text AS content, NULL::bigint AS size_bytes, '' AS creation_date, 1 AS source_order FROM "${sessionsTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}'`,
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
