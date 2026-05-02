import { copyFileSync, chmodSync, existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME, ensureDir, log, pkgRoot, symlinkForce, warn, writeJson } from "./util.js";

/**
 * Shared-deps location for the embedding daemon's runtime dependencies.
 *
 * `@huggingface/transformers` (with onnxruntime-node + sharp) is roughly
 * 600 MB on disk — too large to ship in every agent's plugin install. We
 * install it ONCE here and symlink each agent's <plugin>/node_modules to
 * the shared `node_modules` so node's standard module resolution finds
 * the package via the symlink walk.
 */
export const SHARED_DIR = join(HOME, ".hivemind", "embed-deps");
export const SHARED_NODE_MODULES = join(SHARED_DIR, "node_modules");
export const SHARED_DAEMON_PATH = join(SHARED_DIR, "embed-daemon.js");
export const TRANSFORMERS_PKG = "@huggingface/transformers";
export const TRANSFORMERS_RANGE = "^3.0.0";

export interface AgentInstall {
  id: string;
  pluginDir: string;
}

/**
 * Discover every hivemind plugin install on disk. Each agent's installer
 * lays down the bundle in a known location; we look for those locations
 * and report any that have a `bundle/` directory present.
 *
 * Pure: takes `home` so tests can drive it against a tmp dir without
 * monkey-patching os.homedir().
 */
export function findHivemindInstalls(home: string = HOME): AgentInstall[] {
  const out: AgentInstall[] = [];
  const fixed: AgentInstall[] = [
    { id: "codex", pluginDir: join(home, ".codex", "hivemind") },
    { id: "cursor", pluginDir: join(home, ".cursor", "hivemind") },
    { id: "hermes", pluginDir: join(home, ".hermes", "hivemind") },
  ];
  for (const inst of fixed) {
    if (existsSync(join(inst.pluginDir, "bundle"))) out.push(inst);
  }
  // Claude Code marketplace cache: ~/.claude/plugins/cache/hivemind/hivemind/<version>/
  // Multiple versions can coexist — link each one that has a bundle.
  const ccCache = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind");
  if (existsSync(ccCache)) {
    let entries: string[] = [];
    try { entries = readdirSync(ccCache); } catch { /* unreadable; skip */ }
    for (const ver of entries) {
      const dir = join(ccCache, ver);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      // Bundle layout differs slightly: marketplace installs put it directly
      // under <ver>/bundle, while local-clone-style layouts use <ver>/claude-code/bundle.
      const candidates = [join(dir, "bundle"), join(dir, "claude-code", "bundle")];
      if (candidates.some(p => existsSync(p))) {
        out.push({ id: `claude (${ver})`, pluginDir: dir });
      }
    }
  }
  return out;
}

export function isSharedDepsInstalled(sharedNodeModules: string = SHARED_NODE_MODULES): boolean {
  return existsSync(join(sharedNodeModules, TRANSFORMERS_PKG));
}

function isSymlinkToSharedDeps(linkPath: string, sharedNodeModules: string): boolean {
  if (!existsSync(linkPath)) return false;
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return readlinkSync(linkPath) === sharedNodeModules;
  } catch { return false; }
}

export type LinkState =
  | { kind: "linked-to-shared" }
  | { kind: "no-node-modules" }
  | { kind: "owns-own-node-modules" }
  | { kind: "linked-elsewhere"; target: string };

export function linkStateFor(install: AgentInstall, sharedNodeModules: string = SHARED_NODE_MODULES): LinkState {
  const link = join(install.pluginDir, "node_modules");
  if (!existsSync(link) && !isSymbolicLink(link)) return { kind: "no-node-modules" };
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const target = readlinkSync(link);
      return target === sharedNodeModules
        ? { kind: "linked-to-shared" }
        : { kind: "linked-elsewhere", target };
    }
  } catch {
    return { kind: "no-node-modules" };
  }
  return { kind: "owns-own-node-modules" };
}

function isSymbolicLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function ensureSharedDeps(): void {
  if (!isSharedDepsInstalled()) {
    log(`  Embeddings     installing ${TRANSFORMERS_PKG}@${TRANSFORMERS_RANGE} into ${SHARED_DIR}`);
    log(`                 (~600 MB; first install only — every agent will share this)`);
    ensureDir(SHARED_DIR);
    writeJson(join(SHARED_DIR, "package.json"), {
      name: "hivemind-embed-deps",
      version: "1.0.0",
      private: true,
      dependencies: { [TRANSFORMERS_PKG]: TRANSFORMERS_RANGE },
    });
    execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund"], {
      cwd: SHARED_DIR,
      stdio: "inherit",
    });
  } else {
    log(`  Embeddings     shared deps already present at ${SHARED_DIR}`);
  }
  // Always (re)deposit the canonical embed-daemon.js. Cheap copy; keeps the
  // daemon up-to-date when the user reinstalls hivemind without re-installing
  // the deps. Pi (and any agent that doesn't ship its own bundle) launches
  // this exact file.
  ensureDir(SHARED_DIR);
  const src = join(pkgRoot(), "embeddings", "embed-daemon.js");
  if (existsSync(src)) {
    copyFileSync(src, SHARED_DAEMON_PATH);
    chmodSync(SHARED_DAEMON_PATH, 0o755);
  } else {
    warn(`  Embeddings     standalone daemon bundle missing at ${src} (run 'npm run build' first)`);
  }
}

function linkAgent(install: AgentInstall): void {
  const link = join(install.pluginDir, "node_modules");
  symlinkForce(SHARED_NODE_MODULES, link);
  log(`  Embeddings     linked ${install.id.padEnd(20)} -> shared deps`);
}

/**
 * Install shared embedding deps if missing, then symlink every detected
 * hivemind plugin install to them. Idempotent: re-runs after installing
 * a new agent just add the missing symlink and skip the npm install.
 */
export function enableEmbeddings(): void {
  ensureSharedDeps();
  const installs = findHivemindInstalls();
  if (installs.length === 0) {
    warn("  Embeddings     no hivemind installs detected — run `hivemind install` first");
    warn("                 (the shared deps are in place; subsequent agent installs will pick them up if you re-run `hivemind embeddings install`)");
    return;
  }
  for (const inst of installs) linkAgent(inst);
  log(`  Embeddings     enabled. Restart your agents to pick up.`);
}

/**
 * Remove the symlink each agent's plugin dir has into the shared deps.
 * Optionally prune the shared dir itself if `prune` is set.
 */
export function disableEmbeddings(opts?: { prune?: boolean }): void {
  const installs = findHivemindInstalls();
  for (const inst of installs) {
    const link = join(inst.pluginDir, "node_modules");
    if (isSymlinkToSharedDeps(link, SHARED_NODE_MODULES)) {
      unlinkSync(link);
      log(`  Embeddings     unlinked ${inst.id}`);
    }
  }
  if (opts?.prune && existsSync(SHARED_DIR)) {
    rmSync(SHARED_DIR, { recursive: true, force: true });
    log(`  Embeddings     pruned ${SHARED_DIR}`);
  }
}

export function statusEmbeddings(): void {
  log(`Shared deps:   ${SHARED_DIR}`);
  log(`Installed:     ${isSharedDepsInstalled() ? "yes" : "no"}`);
  log(`Daemon:        ${existsSync(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : "(not present)"}`);
  log("");
  log(`Agent installs:`);
  const installs = findHivemindInstalls();
  if (installs.length === 0) {
    log(`  (none detected)`);
    return;
  }
  for (const inst of installs) {
    const state = linkStateFor(inst);
    let label: string;
    switch (state.kind) {
      case "linked-to-shared":      label = "✓ linked → shared"; break;
      case "no-node-modules":       label = "✗ not linked (embeddings disabled)"; break;
      case "owns-own-node-modules": label = "△ has its own node_modules (not shared)"; break;
      case "linked-elsewhere":      label = `△ linked → ${state.target}`; break;
    }
    log(`  ${inst.id.padEnd(20)} ${label}`);
    log(`  ${" ".repeat(20)}   ${inst.pluginDir}`);
  }
}
