import type { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike, sqlStr } from "../utils/sql.js";

type Row = Record<string, unknown>;

export async function readVirtualPathContent(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  virtualPath: string,
): Promise<string | null> {
  const [memoryRows, sessionRows] = await Promise.all([
    api.query(
      `SELECT summary::text AS content FROM "${memoryTable}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`
    ).catch(() => []),
    api.query(
      `SELECT message::text AS content FROM "${sessionsTable}" WHERE path = '${sqlStr(virtualPath)}' ORDER BY creation_date ASC`
    ).catch(() => []),
  ]);

  if (memoryRows.length > 0 && memoryRows[0]?.["content"]) {
    return String(memoryRows[0]["content"]);
  }

  if (sessionRows.length > 0) {
    const content = sessionRows
      .map(row => row["content"])
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    return content || null;
  }

  return null;
}

export async function listVirtualPathRows(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  dir: string,
): Promise<Row[]> {
  const likePath = `${sqlLike(dir === "/" ? "" : dir)}/%`;
  const [memoryRows, sessionRows] = await Promise.all([
    api.query(
      `SELECT path, size_bytes FROM "${memoryTable}" WHERE path LIKE '${likePath}' ORDER BY path`
    ).catch(() => []),
    api.query(
      `SELECT path, size_bytes FROM "${sessionsTable}" WHERE path LIKE '${likePath}' ORDER BY path`
    ).catch(() => []),
  ]);

  return dedupeRowsByPath([...memoryRows, ...sessionRows]);
}

export async function findVirtualPaths(
  api: DeeplakeApi,
  memoryTable: string,
  sessionsTable: string,
  dir: string,
  filenamePattern: string,
): Promise<string[]> {
  const likePath = `${sqlLike(dir === "/" ? "" : dir)}/%`;
  const [memoryRows, sessionRows] = await Promise.all([
    api.query(
      `SELECT path FROM "${memoryTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}' ORDER BY path`
    ).catch(() => []),
    api.query(
      `SELECT path FROM "${sessionsTable}" WHERE path LIKE '${likePath}' AND filename LIKE '${filenamePattern}' ORDER BY path`
    ).catch(() => []),
  ]);

  return [...new Set(
    [...memoryRows, ...sessionRows]
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
