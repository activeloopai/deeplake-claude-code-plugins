import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_VERSION_CACHE_PATH = join(homedir(), ".deeplake", ".version-check.json");
export const DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

export interface VersionCacheEntry {
  checkedAt: number;
  latest: string | null;
  url: string;
}

export function getInstalledVersion(bundleDir: string, pluginManifestDir: ".claude-plugin" | ".codex-plugin"): string | null {
  try {
    const pluginJson = join(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync(pluginJson, "utf-8"));
    if (plugin.version) return plugin.version;
  } catch { /* fall through */ }

  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version) return pkg.version;
    } catch { /* not here */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/-.*$/, "").split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

export function readVersionCache(cachePath = DEFAULT_VERSION_CACHE_PATH): VersionCacheEntry | null {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (
      parsed
      && typeof parsed.checkedAt === "number"
      && typeof parsed.url === "string"
      && (typeof parsed.latest === "string" || parsed.latest === null)
    ) {
      return parsed as VersionCacheEntry;
    }
  } catch { /* ignore */ }
  return null;
}

export function writeVersionCache(entry: VersionCacheEntry, cachePath = DEFAULT_VERSION_CACHE_PATH): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(entry));
}

export function readFreshCachedLatestVersion(
  url: string,
  ttlMs = DEFAULT_VERSION_CACHE_TTL_MS,
  cachePath = DEFAULT_VERSION_CACHE_PATH,
  nowMs = Date.now(),
): string | null | undefined {
  const cached = readVersionCache(cachePath);
  if (!cached || cached.url !== url) return undefined;
  if ((nowMs - cached.checkedAt) > ttlMs) return undefined;
  return cached.latest;
}

export async function getLatestVersionCached(opts: {
  url: string;
  timeoutMs: number;
  ttlMs?: number;
  cachePath?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const ttlMs = opts.ttlMs ?? DEFAULT_VERSION_CACHE_TTL_MS;
  const cachePath = opts.cachePath ?? DEFAULT_VERSION_CACHE_PATH;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const fresh = readFreshCachedLatestVersion(opts.url, ttlMs, cachePath, nowMs);
  if (fresh !== undefined) return fresh;

  const stale = readVersionCache(cachePath);
  try {
    const res = await fetchImpl(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs) });
    const latest = res.ok ? (await res.json() as { version?: string }).version ?? null : (stale?.latest ?? null);
    writeVersionCache({
      checkedAt: nowMs,
      latest,
      url: opts.url,
    }, cachePath);
    return latest;
  } catch {
    const latest = stale?.latest ?? null;
    writeVersionCache({
      checkedAt: nowMs,
      latest,
      url: opts.url,
    }, cachePath);
    return latest;
  }
}
