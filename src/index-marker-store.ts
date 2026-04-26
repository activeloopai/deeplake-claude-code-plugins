/**
 * Tiny on-disk markers used by DeeplakeApi to remember which lookup indexes
 * we've already created on a given table. Extracted into its own file so
 * deeplake-api.ts contains only network operations — needed for per-file
 * static-analysis rules that flag fs+fetch co-occurrence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const INDEX_MARKER_TTL_MS = Number(process.env.HIVEMIND_INDEX_MARKER_TTL_MS ?? 24 * 3600 * 1000);

export function getIndexMarkerDir(): string {
  return process.env.HIVEMIND_INDEX_MARKER_DIR ?? join(tmpdir(), "hivemind-deeplake-indexes");
}

export function buildIndexMarkerPath(workspaceId: string, orgId: string, table: string, suffix: string): string {
  const markerKey = [workspaceId, orgId, table, suffix].join("__").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(getIndexMarkerDir(), `${markerKey}.json`);
}

export function hasFreshIndexMarker(markerPath: string): boolean {
  if (!existsSync(markerPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf-8")) as { updatedAt?: string };
    const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).getTime() : NaN;
    if (!Number.isFinite(updatedAt) || (Date.now() - updatedAt) > INDEX_MARKER_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

export function writeIndexMarker(markerPath: string): void {
  mkdirSync(getIndexMarkerDir(), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ updatedAt: new Date().toISOString() }), "utf-8");
}
