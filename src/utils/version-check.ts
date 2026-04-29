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
 * Tries three sources, in order:
 *   1. `<bundle>/..<pluginManifestDir>/plugin.json` — claude-code and
 *      codex marketplace/cache layouts pin the version there.
 *   2. `<bundle>/../.hivemind_version` — every agent installer that uses
 *      writeVersionStamp() (cursor / hermes / pi / openclaw / mcp) drops
 *      this plain-text file in PLUGIN_DIR. Without this fallback the
 *      version notice is silently empty for those agents.
 *   3. Walk up from the bundle dir looking for a `package.json` whose
 *      name matches one of HIVEMIND_PKG_NAMES.
 *
 * Returns null if nothing is found — callers treat that as "skip the
 * update check".
 */
export function getInstalledVersion(bundleDir: string, pluginManifestDir: string): string | null {
  try {
    const pluginJson = join(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync(pluginJson, "utf-8"));
    if (plugin.version) return plugin.version;
  } catch { /* fall through */ }
  try {
    const stamp = readFileSync(join(bundleDir, "..", ".hivemind_version"), "utf-8").trim();
    if (stamp) return stamp;
  } catch { /* fall through */ }
  // Walk up from bundleDir looking for our package's package.json.
  // Recognized names — if you publish under another scope, add it here.
  // The npm rename @activeloop/hivemind → @deeplake/hivemind silently
  // broke the version check (returned null → version block skipped) until
  // these scoped names were added.
  const HIVEMIND_PKG_NAMES = new Set([
    "hivemind",
    "hivemind-codex",
    "@deeplake/hivemind",
    "@deeplake/hivemind-codex",
    "@activeloop/hivemind",
    "@activeloop/hivemind-codex",
  ]);
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (HIVEMIND_PKG_NAMES.has(pkg.name) && pkg.version) return pkg.version;
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
