/**
 * Shared install-version / latest-version / version-compare helpers.
 * Used by both the CC and Codex session-start hooks. Each side differs
 * only in the path of its plugin manifest:
 *   - claude-code  → <bundle>/../.claude-plugin/plugin.json
 *   - codex        → <bundle>/../.codex-plugin/plugin.json
 * Callers pass the plugin-manifest name explicitly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";

/**
 * Read the installed plugin version.
 *
 * Tries `<bundle>/..<pluginManifestDir>/plugin.json` first (both the
 * cache layout and the marketplace layout pin the version there), then
 * walks up from the bundle dir looking for a `package.json` whose name
 * is `hivemind` or `hivemind-codex`. Returns null if nothing is found
 * — callers treat that as "skip the update check".
 */
export function getInstalledVersion(bundleDir: string, pluginManifestDir: string): string | null {
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
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Fetch the latest version from GitHub (main branch package.json).
 * Returns null on any failure — session-start hooks must never block
 * on GitHub being reachable, and their callers treat null as "no
 * update available".
 */
export async function getLatestVersion(timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_RAW_PKG, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const pkg = await res.json();
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Strict semantic "latest is greater than current" for dotted x.y.z strings. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}
