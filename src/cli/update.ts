/**
 * `hivemind update` — manual upgrade flow.
 *
 * Single source of truth for upgrades is the npm package
 * `@deeplake/hivemind`. Per-agent autoupdate paths (Claude marketplace,
 * Codex git-clone) are legacy: they remain in src/hooks/* until the next
 * major, but new behavior centralizes here.
 *
 * Three-step flow when a newer version is on npm:
 *   1. Upgrade the CLI itself  (`npm install -g @deeplake/hivemind@latest`)
 *   2. Re-exec the just-installed binary to refresh agent bundles
 *      (so we use the NEW pkgRoot()/bundle paths, not stale in-memory ones)
 *   3. Print a summary
 *
 * The re-exec matters: after `npm install -g @latest` rewrites the install
 * directory, our running process still holds in-memory references to old
 * files. Calling runSingleInstall() in this process would either copy old
 * bundles or hit ENOENT for files that were unlinked-and-replaced. Spawning
 * the new binary side-steps both.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion } from "./version.js";
import { log, warn } from "./util.js";
import { isNewer } from "../utils/version-check.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@deeplake/hivemind/latest";
const PKG_NAME = "@deeplake/hivemind";

export type InstallKind =
  | "npm-global"   // npm install -g @deeplake/hivemind — owns its own prefix dir
  | "npx"          // ran via `npx @deeplake/hivemind` — cached in ~/.npm/_npx
  | "local-dev"    // git checkout / npm link — has a .git nearby
  | "unknown";     // can't tell — refuse to upgrade automatically

export interface DetectedInstall {
  kind: InstallKind;
  /** The directory of the installed package (resolved through symlinks). */
  installDir: string;
}

/**
 * Detect how the running CLI was installed by walking up from
 * the binary's real path.
 *
 * Heuristics, ordered:
 *   - Path contains `/_npx/` or `/.npx/` segment → "npx"
 *   - Path contains `node_modules/@deeplake/hivemind` AND a `.git` dir is
 *     reachable from a parent → "local-dev" (npm-link or sibling checkout)
 *   - Path contains `node_modules/@deeplake/hivemind` → "npm-global"
 *   - A package.json with our name AND a sibling .git dir → "local-dev"
 *   - Otherwise → "unknown"
 */
export function detectInstallKind(argv1?: string): DetectedInstall {
  const realArgv1 = (() => {
    try { return realpathSync(argv1 ?? process.argv[1] ?? fileURLToPath(import.meta.url)); }
    catch { return argv1 ?? process.argv[1] ?? fileURLToPath(import.meta.url); }
  })();

  // Walk up looking for our package.json.
  let dir = dirname(realArgv1);
  let installDir: string | null = null;
  for (let i = 0; i < 10; i++) {
    const pkgPath = `${dir}${sep}package.json`;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name === PKG_NAME || pkg.name === "hivemind") {
        installDir = dir;
        break;
      }
    } catch { /* not here, keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  installDir ??= dirname(realArgv1);

  // Local dev: .git is reachable from a parent of installDir.
  let gitDir = installDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(`${gitDir}${sep}.git`)) {
      return { kind: "local-dev", installDir };
    }
    const parent = dirname(gitDir);
    if (parent === gitDir) break;
    gitDir = parent;
  }

  if (realArgv1.includes(`${sep}_npx${sep}`) || realArgv1.includes(`${sep}.npx${sep}`)) {
    return { kind: "npx", installDir };
  }

  if (realArgv1.includes(`node_modules${sep}@deeplake${sep}hivemind`) ||
      realArgv1.includes(`node_modules${sep}hivemind`)) {
    return { kind: "npm-global", installDir };
  }

  return { kind: "unknown", installDir };
}

/**
 * Fetch the latest version from the npm registry. Returns null on any
 * failure — callers treat that as "skip update".
 *
 * Uses the npm registry directly (not GitHub raw) because npm is now the
 * canonical channel: a git tag without a corresponding npm publish is not
 * a release, so GitHub-raw can lie ahead of npm.
 */
export async function getLatestNpmVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const meta = await res.json() as { version?: string };
    return meta.version ?? null;
  } catch {
    return null;
  }
}

export interface UpdateOptions {
  /** Skip the actual upgrade, just print what would happen. */
  dryRun?: boolean;
  /** Override the install-kind detection (tests). */
  installKindOverride?: DetectedInstall;
  /** Override the latest-version fetch (tests). */
  latestVersionOverride?: string | null;
  /** Override the running version (tests). */
  currentVersionOverride?: string;
  /** Inject the spawn impl (tests). Default: execSync with stdio inherit. */
  spawn?: (cmd: string, args: string[]) => void;
}

const defaultSpawn = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: "inherit" });
};

/**
 * Run the update flow. Returns the exit code the CLI should use.
 *
 * Exit codes:
 *   0 — already up to date OR upgrade succeeded OR dry-run
 *   1 — couldn't reach npm OR upgrade failed OR install kind unsupported
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<number> {
  const current = opts.currentVersionOverride ?? getVersion();
  const latest = opts.latestVersionOverride !== undefined
    ? opts.latestVersionOverride
    : await getLatestNpmVersion();

  if (!latest) {
    warn(`Could not reach npm registry to check for updates.`);
    warn(`Current version: ${current}`);
    return 1;
  }

  if (!isNewer(latest, current)) {
    log(`hivemind ${current} is up to date (npm latest: ${latest}).`);
    return 0;
  }

  log(`Update available: ${current} → ${latest}`);

  if (opts.dryRun) {
    log(`(dry-run) Would run: npm install -g ${PKG_NAME}@latest`);
    log(`(dry-run) Would re-run: hivemind install --skip-auth`);
    return 0;
  }

  const detected = opts.installKindOverride ?? detectInstallKind();
  const spawn = opts.spawn ?? defaultSpawn;

  switch (detected.kind) {
    case "npm-global": {
      log(`Upgrading via npm…`);
      try {
        spawn("npm", ["install", "-g", `${PKG_NAME}@latest`]);
      } catch (e: any) {
        warn(`npm install failed: ${e.message}`);
        warn(`Try running it manually: npm install -g ${PKG_NAME}@latest`);
        return 1;
      }
      log(``);
      log(`Refreshing agent bundles…`);
      try {
        // Re-exec the NEW binary to use new pkgRoot()/bundle paths. The
        // user's $PATH is preserved through stdio: "inherit", so this
        // resolves to the freshly-installed `hivemind` regardless of how
        // npm laid it out.
        spawn("hivemind", ["install", "--skip-auth"]);
      } catch (e: any) {
        warn(`Agent refresh failed: ${e.message}`);
        warn(`Run manually: hivemind install`);
        return 1;
      }
      log(``);
      log(`Updated to ${latest}.`);
      return 0;
    }

    case "npx": {
      log(`You ran hivemind via npx, which does not have a persistent global install.`);
      log(`To use the new version, re-run with the explicit version pin:`);
      log(``);
      log(`  npx ${PKG_NAME}@${latest} install`);
      log(``);
      log(`Or install globally so future updates are one command:`);
      log(``);
      log(`  npm install -g ${PKG_NAME}@latest`);
      return 0;
    }

    case "local-dev": {
      warn(`hivemind is running from a local development checkout (${detected.installDir}).`);
      warn(`Update via your dev workflow (git pull + npm install + npm run build),`);
      warn(`not via 'hivemind update'.`);
      return 1;
    }

    case "unknown":
    default: {
      warn(`Could not determine how hivemind was installed (path: ${detected.installDir}).`);
      warn(`Update manually: npm install -g ${PKG_NAME}@latest`);
      return 1;
    }
  }
}
