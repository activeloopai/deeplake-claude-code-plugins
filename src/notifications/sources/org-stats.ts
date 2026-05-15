/**
 * Org-wide hivemind activity source.
 *
 * Hits `GET /me/hivemind-stats` on the deeplake-api with the user's bearer
 * token. Returns cumulative per-org and per-user aggregates — sessions,
 * memory recalls, memory search bytes — pre-computed by the daily server
 * rollup (`internal/analytics/hivemind_rollup.go`). The local-usage source
 * uses these to render the cross-machine team-wide savings banner; without
 * org data it falls back to the local jsonl recap.
 *
 * Failure paths — timeout, network error, non-200, malformed JSON — all
 * return `null` so callers can fall through to the local-only rendering.
 *
 * Caching: results persist to `~/.deeplake/hivemind-stats-cache.json` for
 * up to one hour. The server rollup runs daily, so per-session freshness
 * isn't meaningful — and the cache trims session-start latency. Cache is
 * invalidated when `apiUrl` changes (e.g. user switches between beta and
 * prod credentials). A stale read still wins over network failure: if the
 * fetch fails AND a stale cached value exists, we return the stale value.
 *
 * Hard fetch timeout: 1.5s. Matches backend.ts; SessionStart hook overall
 * timeout is 5s in hooks.json with headroom for state/queue I/O + delivery.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "../../commands/auth-creds.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-org-stats", msg);

const FETCH_TIMEOUT_MS = 1500;
const DEFAULT_API_URL = "https://api.deeplake.ai";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Cache file path — resolved per-call rather than at module-load time so
 *  tests can redirect HOME (and so a runtime HOME change is honored). */
function cacheFilePath(): string {
  return join(homedir(), ".deeplake", "hivemind-stats-cache.json");
}

export interface OrgStatsScope {
  sessionsCount: number;
  memoryRecallCount: number;
  memorySearchBytes: number;
}

export interface OrgStats {
  org: OrgStatsScope;
  user: OrgStatsScope;
}

interface ServerScope {
  sessions_count?: number;
  memory_recall_count?: number;
  memory_search_bytes?: number;
}

interface ServerResponse {
  org?: ServerScope;
  user?: ServerScope;
}

interface CacheFileShape {
  fetchedAt: number;
  apiUrl: string;
  data: OrgStats;
}

/** Coerce a server-side number that might be missing, null, or non-numeric.
 *  Defaults to 0 so a partial response (e.g. server adds a field that
 *  isn't yet rolled up) renders as zero rather than NaN. */
function scopeFromServer(s: ServerScope | undefined): OrgStatsScope {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    sessionsCount: n(s?.sessions_count),
    memoryRecallCount: n(s?.memory_recall_count),
    memorySearchBytes: n(s?.memory_search_bytes),
  };
}

function readCache(apiUrl: string): { fresh?: OrgStats; stale?: OrgStats } {
  if (!existsSync(cacheFilePath())) return {};
  try {
    const parsed = JSON.parse(readFileSync(cacheFilePath(), "utf-8")) as CacheFileShape;
    if (!parsed || typeof parsed !== "object") return {};
    if (parsed.apiUrl !== apiUrl) return {};
    if (typeof parsed.fetchedAt !== "number") return {};
    const age = Date.now() - parsed.fetchedAt;
    const data = parsed.data;
    if (!data || typeof data !== "object" || !data.org || !data.user) return {};
    if (age >= 0 && age < CACHE_TTL_MS) return { fresh: data };
    // Stale but possibly useful as a fallback if the fetch fails. We don't
    // return it as "fresh" since the user has paid for newer data via a
    // SessionStart-triggered fetch — only return it after the fetch error.
    return { stale: data };
  } catch (e: any) {
    log(`cache read failed: ${e?.message ?? String(e)}`);
    return {};
  }
}

function writeCache(apiUrl: string, data: OrgStats): void {
  try {
    const body: CacheFileShape = { fetchedAt: Date.now(), apiUrl, data };
    writeFileSync(cacheFilePath(), JSON.stringify(body), "utf-8");
  } catch (e: any) {
    // Don't fail the read path if disk write fails; just log.
    log(`cache write failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Fetch org/user hivemind stats. Never throws. Returns null when stats
 * are unavailable; caller (local-usage source) falls back to the local
 * jsonl recap in that case.
 *
 * Order of operations:
 *   1. Return fresh cache if present (<1h old, same apiUrl)
 *   2. Otherwise, fetch from server with 1.5s timeout
 *   3. On success: persist to cache, return new data
 *   4. On failure: return stale cache if any, else null
 */
export async function fetchOrgStats(creds: Credentials | null): Promise<OrgStats | null> {
  if (!creds?.token) return null;

  const apiUrl = creds.apiUrl ?? DEFAULT_API_URL;
  const { fresh, stale } = readCache(apiUrl);
  if (fresh) {
    log("cache hit — returning fresh org stats");
    return fresh;
  }

  const url = `${apiUrl}/me/hivemind-stats`;
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        ...(creds.orgId ? { "X-Activeloop-Org-Id": creds.orgId } : {}),
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      log(`fetch ${url} returned ${resp.status}`);
      return stale ?? null;
    }
    const body = (await resp.json()) as ServerResponse;
    if (!body || typeof body !== "object") {
      log(`fetch ${url} returned malformed body`);
      return stale ?? null;
    }
    const data: OrgStats = {
      org: scopeFromServer(body.org),
      user: scopeFromServer(body.user),
    };
    writeCache(apiUrl, data);
    log(`fetched org stats from ${apiUrl}`);
    return data;
  } catch (e: any) {
    log(`fetch ${url} failed: ${e?.message ?? String(e)}`);
    return stale ?? null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** For tests only: clears the cache file so a test seed is the only data
 *  considered. Use beforeEach to prevent prior-test stats leaking. */
export function _clearCacheForTest(): void {
  try {
    if (existsSync(cacheFilePath())) {
      // Empty write rather than unlink — keeps the file's permissions and
      // makes the "no file" vs "empty file" code paths converge.
      writeFileSync(cacheFilePath(), "", "utf-8");
    }
  } catch {
    // ignore — tests can still proceed with a stale cache file
  }
}
