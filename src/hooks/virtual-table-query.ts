import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";

type Row = Record<string, unknown>;

export function buildVirtualIndexContent(rows: Row[]): string {
  const lines = ["# Memory Index", "", `${rows.length} sessions:`, ""];
  for (const row of rows) {
    const path = row["path"] as string;
    const project = row["project"] as string || "";
    const description = (row["description"] as string || "").slice(0, 120);
    const date = (row["creation_date"] as string || "").slice(0, 10);
    lines.push(`- [${path}](${path}) ${date} ${project ? `[${project}]` : ""} ${description}`);
  }
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
  const clauses = cleaned.map((dir) => `path LIKE '${sqlLike(dir)}/%'`);
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
      current.push(content);
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
    const rows = await api.query(
      `SELECT path, project, description, creation_date FROM "${memoryTable}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`
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
