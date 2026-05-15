import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getInstalledVersion } from "../../src/utils/version-check.js";

/**
 * Per-agent guard for the plugin_version feature.
 *
 * Every capture hook stamps a row's `plugin_version` column by calling
 * `getInstalledVersion(__bundleDir, <manifestDir>)` at module load. The
 * function has three lookup paths (manifest → .hivemind_version stamp →
 * walk-up package.json) all covered by utils-version-check.test.ts.
 *
 * What that file does NOT cover: that each agent's actual on-disk layout
 * — the files we ship in the marketplace bundle — resolves to a non-empty
 * version through one of those paths. A silent regression here (rename
 * a manifest dir, drop the stamp from an installer, change package.json
 * name) would land empty `plugin_version` strings in prod with no test
 * failure, exactly the bug we'd otherwise catch only by e2e per agent.
 *
 * The assertion is "resolves to a semver-shaped non-empty string", not
 * "matches repo package.json version" — the codex `.codex-plugin/plugin.json`
 * has historically drifted from the repo-level version (a separate release
 * bug), and locking the two together would couple this guard to that
 * unrelated process. Each entry below mirrors the manifest dir actually
 * passed in the agent's bundled `capture.ts` / `session-start.ts`; keep
 * this list in sync with those call sites.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");

interface AgentLayout {
  agent: string;
  bundleDir: string;
  manifestDir: string;
}

const AGENTS: AgentLayout[] = [
  { agent: "claude-code", bundleDir: resolve(REPO_ROOT, "claude-code", "bundle"), manifestDir: ".claude-plugin" },
  { agent: "codex",       bundleDir: resolve(REPO_ROOT, "codex", "bundle"),       manifestDir: ".codex-plugin" },
  { agent: "cursor",      bundleDir: resolve(REPO_ROOT, "cursor", "bundle"),      manifestDir: ".claude-plugin" },
  { agent: "hermes",      bundleDir: resolve(REPO_ROOT, "hermes", "bundle"),      manifestDir: ".claude-plugin" },
  { agent: "pi",          bundleDir: resolve(REPO_ROOT, "pi", "bundle"),          manifestDir: ".claude-plugin" },
];

describe("plugin_version stamps a non-empty value for every shipped agent", () => {
  it.each(AGENTS)("$agent resolves getInstalledVersion to a semver string", ({ bundleDir, manifestDir }) => {
    // The repo-level package.json has name "@deeplake/hivemind" (in the
    // HIVEMIND_PKG_NAMES set), so even agents without an in-repo manifest
    // (cursor/hermes/pi) resolve via the walk-up fallback — and at real
    // install time their installer drops a .hivemind_version stamp, also
    // covered. Either way the runtime must NOT see an empty string here.
    const version = getInstalledVersion(bundleDir, manifestDir);
    expect(version, `${manifestDir} from ${bundleDir} must resolve a version`).not.toBeNull();
    // Accept full SemVer 2.0: x.y.z plus optional -prerelease and +build
    // segments. We don't ship prerelease today but a future RC tag
    // (0.8.0-rc.1) shouldn't make this guard fail.
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  });
});

describe("plugin_version is wired into every agent's capture INSERT", () => {
  // Bundle-level guard: the column must appear in the shipped INSERT
  // SQL for every agent's session-event writer. Mirrors the spirit of
  // wiki-worker-upload-sql.test.ts.
  const CAPTURE_BUNDLES: Array<[string, string]> = [
    ["claude-code capture", resolve(REPO_ROOT, "claude-code", "bundle", "capture.js")],
    ["codex capture",       resolve(REPO_ROOT, "codex", "bundle", "capture.js")],
    ["cursor capture",      resolve(REPO_ROOT, "cursor", "bundle", "capture.js")],
    ["hermes capture",      resolve(REPO_ROOT, "hermes", "bundle", "capture.js")],
    ["codex stop",          resolve(REPO_ROOT, "codex", "bundle", "stop.js")],
    ["openclaw index",      resolve(REPO_ROOT, "openclaw", "dist", "index.js")],
  ];

  it.each(CAPTURE_BUNDLES)("%s INSERT lists plugin_version column", (_label, path) => {
    const src = readFileSync(path, "utf-8");
    // The INSERT into the sessions table must include plugin_version in
    // its column list. Regex matches the actual concatenated INSERT line
    // so a typo or column-list drift fails here, not silently in prod.
    const sessionsInsert = /INSERT INTO\s+"\$\{sessionsTable\}"[^`]*?plugin_version[^`]*?VALUES/;
    expect(src).toMatch(sessionsInsert);
  });
});

describe("plugin_version is wired into every agent's session-start placeholder INSERT", () => {
  const PLACEHOLDER_BUNDLES: Array<[string, string]> = [
    ["claude-code session-start", resolve(REPO_ROOT, "claude-code", "bundle", "session-start.js")],
    ["codex session-start-setup", resolve(REPO_ROOT, "codex", "bundle", "session-start-setup.js")],
    ["cursor session-start",      resolve(REPO_ROOT, "cursor", "bundle", "session-start.js")],
    ["hermes session-start",      resolve(REPO_ROOT, "hermes", "bundle", "session-start.js")],
  ];

  it.each(PLACEHOLDER_BUNDLES)("%s placeholder INSERT lists plugin_version column", (_label, path) => {
    const src = readFileSync(path, "utf-8");
    const placeholderInsert = /INSERT INTO\s+"\$\{table\}"[^`]*?plugin_version[^`]*?VALUES/;
    expect(src).toMatch(placeholderInsert);
  });
});
