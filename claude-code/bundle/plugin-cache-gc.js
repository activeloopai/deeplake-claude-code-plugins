#!/usr/bin/env node

// dist/src/hooks/plugin-cache-gc.js
import { fileURLToPath } from "node:url";
import { dirname as dirname2 } from "node:path";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
var LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/utils/plugin-cache.js
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join as join2, resolve, sep } from "node:path";
import { homedir as homedir2 } from "node:os";
var SEMVER_RE = /^\d+\.\d+\.\d+$/;
var KEEP_RE = /\.keep-(\d+)$/;
function isSemver(name) {
  return SEMVER_RE.test(name);
}
function compareSemverDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i])
      return pb[i] - pa[i];
  }
  return 0;
}
function resolveVersionedPluginDir(bundleDir) {
  const pluginDir = dirname(bundleDir);
  const versionsRoot = dirname(pluginDir);
  const version = basename(pluginDir);
  if (!isSemver(version))
    return null;
  if (basename(versionsRoot) !== "hivemind")
    return null;
  const expectedPrefix = resolve(homedir2(), ".claude", "plugins", "cache") + sep;
  if (!resolve(versionsRoot).startsWith(expectedPrefix))
    return null;
  return { pluginDir, versionsRoot, version };
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function readCurrentVersionFromManifest(manifestPath) {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.plugins?.["hivemind@hivemind"];
    if (!Array.isArray(entries))
      return null;
    for (const e of entries) {
      if (typeof e?.version === "string" && isSemver(e.version))
        return e.version;
    }
    return null;
  } catch {
    return null;
  }
}
function planGc(versionsRoot, currentVersion, keepCount, isAlive = isPidAlive) {
  const entries = safeReaddir(versionsRoot);
  const versions = entries.filter(isSemver);
  const snapshots = entries.filter((e) => KEEP_RE.test(e));
  const sorted = [...versions].sort(compareSemverDesc);
  const keep = /* @__PURE__ */ new Set();
  if (currentVersion && versions.includes(currentVersion))
    keep.add(currentVersion);
  for (const v of sorted) {
    if (keep.size >= keepCount)
      break;
    keep.add(v);
  }
  const deleteVersions = [];
  if (currentVersion && versions.includes(currentVersion)) {
    for (const v of versions) {
      if (!keep.has(v))
        deleteVersions.push(v);
    }
  }
  const deleteSnapshots = [];
  for (const s of snapshots) {
    const m = s.match(KEEP_RE);
    if (!m)
      continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || !isAlive(pid))
      deleteSnapshots.push(s);
  }
  return { keep: [...keep], deleteVersions, deleteSnapshots };
}
function executeGc(versionsRoot, plan) {
  const errors = [];
  const deletedVersions = [];
  const deletedSnapshots = [];
  for (const v of plan.deleteVersions) {
    const target = join2(versionsRoot, v);
    try {
      rmSync(target, { recursive: true, force: true });
      deletedVersions.push(v);
    } catch (e) {
      errors.push(`${v}: ${e.message}`);
    }
  }
  for (const s of plan.deleteSnapshots) {
    const target = join2(versionsRoot, s);
    try {
      rmSync(target, { recursive: true, force: true });
      deletedSnapshots.push(s);
    } catch (e) {
      errors.push(`${s}: ${e.message}`);
    }
  }
  return { kept: plan.keep, deletedVersions, deletedSnapshots, errors };
}
function safeReaddir(dir) {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join2(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
var DEFAULT_MANIFEST_PATH = join2(homedir2(), ".claude", "plugins", "installed_plugins.json");
var DEFAULT_KEEP_COUNT = 3;

// dist/src/hooks/plugin-cache-gc.js
var log2 = (msg) => log("plugin-cache-gc", msg);
var __bundleDir = dirname2(fileURLToPath(import.meta.url));
function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  const resolved = resolveVersionedPluginDir(__bundleDir);
  if (!resolved) {
    log2("not a versioned install, skipping");
    return;
  }
  const currentVersion = readCurrentVersionFromManifest(DEFAULT_MANIFEST_PATH);
  const plan = planGc(resolved.versionsRoot, currentVersion, DEFAULT_KEEP_COUNT);
  if (plan.deleteVersions.length === 0 && plan.deleteSnapshots.length === 0) {
    log2(`nothing to gc (kept: ${plan.keep.join(", ")})`);
    return;
  }
  const result = executeGc(resolved.versionsRoot, plan);
  log2(`gc kept=${result.kept.join(",")} deletedVersions=${result.deletedVersions.join(",")} deletedSnapshots=${result.deletedSnapshots.join(",")} errors=${result.errors.length}`);
}
try {
  main();
} catch (e) {
  log2(`fatal: ${e.message}`);
}
