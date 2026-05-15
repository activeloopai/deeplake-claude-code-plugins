#!/usr/bin/env node

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/src/config.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
function loadConfig() {
  const home = homedir();
  const credPath = join(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync(credPath)) {
    try {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch {
      return null;
    }
  }
  const token = process.env.HIVEMIND_TOKEN ?? creds?.token;
  const orgId = process.env.HIVEMIND_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.HIVEMIND_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.HIVEMIND_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.HIVEMIND_TABLE ?? "memory",
    sessionsTableName: process.env.HIVEMIND_SESSIONS_TABLE ?? "sessions",
    skillsTableName: process.env.HIVEMIND_SKILLS_TABLE ?? "skills",
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? join(home, ".deeplake", "memory")
  };
}

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/spawn-wiki-worker.js
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join5 } from "node:path";
import { writeFileSync, mkdirSync as mkdirSync2 } from "node:fs";
import { homedir as homedir3, tmpdir } from "node:os";

// dist/src/utils/wiki-log.js
import { mkdirSync, appendFileSync as appendFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function makeWikiLogger(hooksDir, filename = "deeplake-wiki.log") {
  const path = join3(hooksDir, filename);
  return {
    path,
    log(msg) {
      try {
        mkdirSync(hooksDir, { recursive: true });
        appendFileSync2(path, `[${utcTimestamp()}] ${msg}
`);
      } catch {
      }
    }
  };
}

// dist/src/utils/version-check.js
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname, join as join4 } from "node:path";
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join4(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync2(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  try {
    const stamp = readFileSync2(join4(bundleDir, "..", ".hivemind_version"), "utf-8").trim();
    if (stamp)
      return stamp;
  } catch {
  }
  const HIVEMIND_PKG_NAMES = /* @__PURE__ */ new Set([
    "hivemind",
    "hivemind-codex",
    "@deeplake/hivemind",
    "@deeplake/hivemind-codex",
    "@activeloop/hivemind",
    "@activeloop/hivemind-codex"
  ]);
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join4(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync2(candidate, "utf-8"));
      if (HIVEMIND_PKG_NAMES.has(pkg.name) && pkg.version)
        return pkg.version;
    } catch {
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}

// dist/src/hooks/spawn-wiki-worker.js
var HOME = homedir3();
var wikiLogger = makeWikiLogger(join5(HOME, ".claude", "hooks"));
var WIKI_LOG = wikiLogger.path;
var WIKI_PROMPT_TEMPLATE = `You are building a personal wiki from a coding session. Your goal is to extract every piece of knowledge \u2014 entities, decisions, relationships, and facts \u2014 into a structured, searchable wiki entry. Think of this as building a knowledge graph, not writing a summary.

SESSION JSONL path: __JSONL__
SUMMARY FILE to write: __SUMMARY__
SESSION ID: __SESSION_ID__
PROJECT: __PROJECT__
PREVIOUS JSONL OFFSET (lines already processed): __PREV_OFFSET__
CURRENT JSONL LINES: __JSONL_LINES__

Steps:
1. Read the session JSONL at the path above.
   - If PREVIOUS JSONL OFFSET > 0, this is a resumed session. Read the existing summary file first,
     then focus on lines AFTER the offset for new content. Merge new facts into the existing summary.
   - If offset is 0, generate from scratch.

2. Write the summary file at the path above with this EXACT format. The header fields (Source, Project) are pre-filled \u2014 copy them VERBATIM, do NOT replace them with paths from the JSONL content:

# Session __SESSION_ID__
- **Source**: __JSONL_SERVER_PATH__
- **Started**: <extract from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__
- **JSONL offset**: __JSONL_LINES__

## What Happened
<2-3 dense sentences. What was the goal, what was accomplished, what's left.>

## People
<For each person mentioned: name, role, what they did/said. Format: **Name** \u2014 role \u2014 action>

## Entities
<Every named thing: repos, branches, files, APIs, tools, services, tables, features, bugs.
Format: **entity** (type) \u2014 what was done with it, its current state>

## Decisions & Reasoning
<Every decision made and WHY. Not just "did X" but "did X because Y, considered Z but rejected it because W">

## Key Facts
<Bullet list of atomic facts that could answer future questions. Each fact should stand alone.
Example: "- The memory table uses DELETE+INSERT, not UPDATE (WASM doesn't support upsert)">

## Files Modified
<bullet list: path (new/modified/deleted) \u2014 what changed>

## Open Questions / TODO
<Anything unresolved, blocked, or explicitly deferred>

IMPORTANT: Be exhaustive. Extract EVERY entity, decision, and fact. Future you will search this wiki to answer questions like "who worked on X", "why did we choose Y", "what's the status of Z". If a detail exists in the session, it should be in the wiki.

PRIVACY: Never include absolute filesystem paths (e.g. /home/user/..., /Users/..., C:\\\\...) in the summary. Use only project-relative paths or the project name. The Source and Project fields above are already correct \u2014 do not change them.

LENGTH LIMIT: Keep the total summary under 4000 characters. Be dense and concise \u2014 prioritize facts over prose. If a session is short, the summary should be short too.`;
var wikiLog = wikiLogger.log;
function findClaudeBin() {
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return join5(HOME, ".claude", "local", "claude");
  }
}
function spawnWikiWorker(opts) {
  const { config, sessionId, cwd, bundleDir, reason } = opts;
  const projectName = cwd.split("/").pop() || "unknown";
  const tmpDir = join5(tmpdir(), `deeplake-wiki-${sessionId}-${Date.now()}`);
  mkdirSync2(tmpDir, { recursive: true });
  const pluginVersion = getInstalledVersion(bundleDir, ".claude-plugin") ?? "";
  const configFile = join5(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    memoryTable: config.tableName,
    sessionsTable: config.sessionsTableName,
    sessionId,
    userName: config.userName,
    project: projectName,
    pluginVersion,
    tmpDir,
    claudeBin: findClaudeBin(),
    wikiLog: WIKI_LOG,
    hooksDir: join5(HOME, ".claude", "hooks"),
    promptTemplate: WIKI_PROMPT_TEMPLATE
  }));
  wikiLog(`${reason}: spawning summary worker for ${sessionId}`);
  const workerPath = join5(bundleDir, "wiki-worker.js");
  spawn("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  wikiLog(`${reason}: spawned summary worker for ${sessionId}`);
}
function bundleDirFromImportMeta(importMetaUrl) {
  return dirname2(fileURLToPath(importMetaUrl));
}

// dist/src/hooks/summary-state.js
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, writeSync, mkdirSync as mkdirSync3, renameSync, existsSync as existsSync2, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";
var dlog = (msg) => log("summary-state", msg);
var STATE_DIR = join6(homedir4(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function lockPath(sessionId) {
  return join6(STATE_DIR, `${sessionId}.lock`);
}
function tryAcquireLock(sessionId, maxAgeMs = 10 * 60 * 1e3) {
  mkdirSync3(STATE_DIR, { recursive: true });
  const p = lockPath(sessionId);
  if (existsSync2(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync3(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog(`lock file unreadable for ${sessionId}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync(p);
    } catch (unlinkErr) {
      dlog(`could not unlink stale lock for ${sessionId}: ${unlinkErr.message}`);
      return false;
    }
  }
  try {
    const fd = openSync(p, "wx");
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e.code === "EEXIST")
      return false;
    throw e;
  }
}
function releaseLock(sessionId) {
  try {
    unlinkSync(lockPath(sessionId));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      dlog(`releaseLock unlink failed for ${sessionId}: ${e.message}`);
    }
  }
}

// dist/src/skillify/spawn-skillify-worker.js
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join8 } from "node:path";
import { writeFileSync as writeFileSync3, mkdirSync as mkdirSync4, appendFileSync as appendFileSync3, chmodSync } from "node:fs";
import { homedir as homedir6, tmpdir as tmpdir2 } from "node:os";

// dist/src/skillify/gate-runner.js
import { execFileSync } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join7 } from "node:path";
function findAgentBin(agent) {
  const which = (name) => {
    try {
      const out = execFileSync("which", [name], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  };
  switch (agent) {
    case "claude_code":
      return which("claude") ?? join7(homedir5(), ".claude", "local", "claude");
    case "codex":
      return which("codex") ?? "/usr/local/bin/codex";
    case "cursor":
      return which("cursor-agent") ?? "/usr/local/bin/cursor-agent";
    case "hermes":
      return which("hermes") ?? join7(homedir5(), ".local", "bin", "hermes");
    case "pi":
      return which("pi") ?? join7(homedir5(), ".local", "bin", "pi");
  }
}

// dist/src/skillify/spawn-skillify-worker.js
var HOME2 = homedir6();
var SKILLIFY_LOG = join8(HOME2, ".claude", "hooks", "skillify.log");
function skillifyLog(msg) {
  try {
    mkdirSync4(dirname3(SKILLIFY_LOG), { recursive: true });
    appendFileSync3(SKILLIFY_LOG, `[${utcTimestamp()}] ${msg}
`);
  } catch {
  }
}
function spawnSkillifyWorker(opts) {
  const { config, cwd, projectKey, project, bundleDir, agent, scopeConfig, currentSessionId, reason } = opts;
  const tmpDir = join8(tmpdir2(), `deeplake-skillify-${projectKey}-${Date.now()}`);
  mkdirSync4(tmpDir, { recursive: true, mode: 448 });
  const gateBin = findAgentBin(agent);
  const configFile = join8(tmpDir, "config.json");
  writeFileSync3(configFile, JSON.stringify({
    apiUrl: config.apiUrl,
    token: config.token,
    orgId: config.orgId,
    workspaceId: config.workspaceId,
    sessionsTable: config.sessionsTableName,
    skillsTable: config.skillsTableName,
    userName: config.userName,
    cwd,
    projectKey,
    project,
    agent,
    scope: scopeConfig.scope,
    team: scopeConfig.team,
    install: scopeConfig.install,
    tmpDir,
    gateBin,
    cursorModel: process.env.HIVEMIND_CURSOR_MODEL,
    hermesProvider: process.env.HIVEMIND_HERMES_PROVIDER,
    hermesModel: process.env.HIVEMIND_HERMES_MODEL,
    piProvider: process.env.HIVEMIND_PI_PROVIDER,
    piModel: process.env.HIVEMIND_PI_MODEL,
    skillifyLog: SKILLIFY_LOG,
    currentSessionId
  }), { mode: 384 });
  try {
    chmodSync(configFile, 384);
  } catch {
  }
  skillifyLog(`${reason}: spawning skillify worker for project=${project} key=${projectKey}`);
  const workerPath = join8(bundleDir, "skillify-worker.js");
  spawn2("nohup", ["node", workerPath, configFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  }).unref();
  skillifyLog(`${reason}: spawned skillify worker for ${projectKey}`);
}

// dist/src/skillify/state.js
import { readFileSync as readFileSync4, writeFileSync as writeFileSync4, writeSync as writeSync2, mkdirSync as mkdirSync5, renameSync as renameSync3, existsSync as existsSync5, unlinkSync as unlinkSync2, openSync as openSync2, closeSync as closeSync2 } from "node:fs";
import { execSync as execSync2 } from "node:child_process";
import { homedir as homedir8 } from "node:os";
import { createHash } from "node:crypto";
import { join as join10, basename } from "node:path";

// dist/src/skillify/legacy-migration.js
import { existsSync as existsSync4, renameSync as renameSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join9 } from "node:path";
var dlog2 = (msg) => log("skillify-migrate", msg);
var attempted = false;
function migrateLegacyStateDir() {
  if (attempted)
    return;
  attempted = true;
  const root = join9(homedir7(), ".deeplake", "state");
  const legacy = join9(root, "skilify");
  const current = join9(root, "skillify");
  if (!existsSync4(legacy))
    return;
  if (existsSync4(current))
    return;
  try {
    renameSync2(legacy, current);
    dlog2(`migrated ${legacy} -> ${current}`);
  } catch (err) {
    const code = err.code;
    if (code === "EXDEV" || code === "EPERM") {
      dlog2(`migration failed (${code}); leaving legacy dir in place`);
      return;
    }
    throw err;
  }
}

// dist/src/skillify/state.js
var dlog3 = (msg) => log("skillify-state", msg);
var STATE_DIR2 = join10(homedir8(), ".deeplake", "state", "skillify");
var YIELD_BUF2 = new Int32Array(new SharedArrayBuffer(4));
var TRIGGER_THRESHOLD = (() => {
  const n = Number(process.env.HIVEMIND_SKILLIFY_EVERY_N_TURNS ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
})();
function statePath(projectKey) {
  return join10(STATE_DIR2, `${projectKey}.json`);
}
function lockPath2(projectKey) {
  return join10(STATE_DIR2, `${projectKey}.lock`);
}
var DEFAULT_PORTS = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418"
};
function normalizeGitRemoteUrl(url) {
  let s = url.trim();
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  if (schemeMatch)
    s = s.slice(schemeMatch[0].length);
  if (!scheme) {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp)
      s = `${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/^[^@/]+@/, "");
  if (scheme && DEFAULT_PORTS[scheme]) {
    s = s.replace(new RegExp(`^([^/]+):${DEFAULT_PORTS[scheme]}(/|$)`), "$1$2");
  }
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}
function deriveProjectKey(cwd) {
  const project = basename(cwd) || "unknown";
  let signature = null;
  try {
    const raw = execSync2("git config --get remote.origin.url", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    signature = raw ? normalizeGitRemoteUrl(raw) : null;
  } catch {
  }
  const input = signature ?? cwd;
  const key = createHash("sha1").update(input).digest("hex").slice(0, 16);
  return { key, project };
}
function readState(projectKey) {
  migrateLegacyStateDir();
  const p = statePath(projectKey);
  if (!existsSync5(p))
    return null;
  try {
    return JSON.parse(readFileSync4(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(projectKey, state) {
  migrateLegacyStateDir();
  mkdirSync5(STATE_DIR2, { recursive: true });
  const p = statePath(projectKey);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync4(tmp, JSON.stringify(state, null, 2));
  renameSync3(tmp, p);
}
function withRmwLock(projectKey, fn) {
  migrateLegacyStateDir();
  mkdirSync5(STATE_DIR2, { recursive: true });
  const rmw = lockPath2(projectKey) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync2(rmw, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        dlog3(`rmw lock deadline exceeded for ${projectKey}, reclaiming stale lock`);
        try {
          unlinkSync2(rmw);
        } catch (unlinkErr) {
          dlog3(`stale rmw lock unlink failed for ${projectKey}: ${unlinkErr.message}`);
        }
        continue;
      }
      Atomics.wait(YIELD_BUF2, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync2(fd);
    try {
      unlinkSync2(rmw);
    } catch (unlinkErr) {
      dlog3(`rmw lock cleanup failed for ${projectKey}: ${unlinkErr.message}`);
    }
  }
}
function resetCounter(projectKey) {
  withRmwLock(projectKey, () => {
    const s = readState(projectKey);
    if (!s)
      return;
    writeState(projectKey, { ...s, counter: 0, updatedAt: Date.now() });
  });
}
function tryAcquireWorkerLock(projectKey, maxAgeMs = 10 * 60 * 1e3) {
  migrateLegacyStateDir();
  mkdirSync5(STATE_DIR2, { recursive: true });
  const p = lockPath2(projectKey);
  if (existsSync5(p)) {
    try {
      const ageMs = Date.now() - parseInt(readFileSync4(p, "utf-8"), 10);
      if (Number.isFinite(ageMs) && ageMs < maxAgeMs)
        return false;
    } catch (readErr) {
      dlog3(`worker lock unreadable for ${projectKey}, treating as stale: ${readErr.message}`);
    }
    try {
      unlinkSync2(p);
    } catch (unlinkErr) {
      dlog3(`could not unlink stale worker lock for ${projectKey}: ${unlinkErr.message}`);
      return false;
    }
  }
  try {
    const fd = openSync2(p, "wx");
    try {
      writeSync2(fd, String(Date.now()));
    } finally {
      closeSync2(fd);
    }
    return true;
  } catch {
    return false;
  }
}
function releaseWorkerLock(projectKey) {
  const p = lockPath2(projectKey);
  try {
    unlinkSync2(p);
  } catch {
  }
}

// dist/src/skillify/scope-config.js
import { existsSync as existsSync6, mkdirSync as mkdirSync6, readFileSync as readFileSync5, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { join as join11 } from "node:path";
var STATE_DIR3 = join11(homedir9(), ".deeplake", "state", "skillify");
var CONFIG_PATH = join11(STATE_DIR3, "config.json");
var DEFAULT = { scope: "me", team: [], install: "project" };
function loadScopeConfig() {
  migrateLegacyStateDir();
  if (!existsSync6(CONFIG_PATH))
    return DEFAULT;
  try {
    const raw = JSON.parse(readFileSync5(CONFIG_PATH, "utf-8"));
    const scope = raw.scope === "team" ? "team" : raw.scope === "org" ? "team" : "me";
    const team = Array.isArray(raw.team) ? raw.team.filter((s) => typeof s === "string") : [];
    const install = raw.install === "global" ? "global" : "project";
    return { scope, team, install };
  } catch {
    return DEFAULT;
  }
}

// dist/src/skillify/triggers.js
function forceSessionEndTrigger(opts) {
  if (process.env.HIVEMIND_SKILLIFY_WORKER === "1")
    return;
  if (!opts.cwd)
    return;
  try {
    const { key: projectKey, project } = deriveProjectKey(opts.cwd);
    if (!tryAcquireWorkerLock(projectKey)) {
      skillifyLog(`SessionEnd: skillify worker already running for ${projectKey}, skipping`);
      return;
    }
    if (readState(projectKey)) {
      resetCounter(projectKey);
    }
    skillifyLog(`SessionEnd: spawning skillify worker for project=${project} agent=${opts.agent}`);
    try {
      spawnSkillifyWorker({
        config: opts.config,
        cwd: opts.cwd,
        projectKey,
        project,
        bundleDir: opts.bundleDir,
        agent: opts.agent,
        scopeConfig: loadScopeConfig(),
        currentSessionId: opts.sessionId,
        reason: "SessionEnd"
      });
    } catch (e) {
      skillifyLog(`SessionEnd spawn failed: ${e?.message ?? e}`);
      try {
        releaseWorkerLock(projectKey);
      } catch {
      }
    }
  } catch (e) {
    skillifyLog(`SessionEnd trigger error: ${e?.message ?? e}`);
  }
}

// dist/src/notifications/transcript-parser.js
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "node:fs";
var log2 = (msg) => log("transcript-parser", msg);
function parseTranscript(transcriptPath, fallbackSessionId, now = /* @__PURE__ */ new Date()) {
  const empty = {
    endedAt: now.toISOString(),
    sessionId: fallbackSessionId,
    memorySearchBytes: 0,
    memorySearchCount: 0
  };
  if (!transcriptPath || !existsSync7(transcriptPath)) {
    log2(`transcript missing: ${transcriptPath}`);
    return empty;
  }
  let raw;
  try {
    raw = readFileSync6(transcriptPath, "utf-8");
  } catch (e) {
    log2(`read failed: ${e?.message ?? String(e)}`);
    return empty;
  }
  const memoryLookupToolUseIds = /* @__PURE__ */ new Set();
  let memorySearchBytes = 0;
  let memorySearchCount = 0;
  let sessionId = fallbackSessionId;
  let endedAt = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string")
      endedAt = entry.timestamp;
    if (typeof entry.sessionId === "string" && entry.sessionId)
      sessionId = entry.sessionId;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content))
      continue;
    if (msg.role === "assistant") {
      for (const c of msg.content) {
        if (c && c.type === "tool_use" && c.name === "Bash" && c.input && typeof c.input.command === "string" && isMemoryLookupCommand(c.input.command)) {
          memorySearchCount += 1;
          if (typeof c.id === "string")
            memoryLookupToolUseIds.add(c.id);
        }
      }
    } else if (msg.role === "user") {
      for (const c of msg.content) {
        if (c && c.type === "tool_result" && typeof c.tool_use_id === "string" && memoryLookupToolUseIds.has(c.tool_use_id)) {
          memorySearchBytes += toolResultByteLength(c.content);
        }
      }
    }
  }
  return {
    endedAt: endedAt || now.toISOString(),
    sessionId,
    memorySearchBytes,
    memorySearchCount
  };
}
function isMemoryLookupCommand(command) {
  return command.includes(".deeplake/memory");
}
function toolResultByteLength(content) {
  if (typeof content === "string")
    return Buffer.byteLength(content, "utf-8");
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        const txt = part.text;
        if (typeof txt === "string")
          n += Buffer.byteLength(txt, "utf-8");
      }
    }
    return n;
  }
  try {
    return Buffer.byteLength(JSON.stringify(content ?? ""), "utf-8");
  } catch {
    return 0;
  }
}

// dist/src/notifications/usage-tracker.js
import { appendFileSync as appendFileSync4, existsSync as existsSync8, mkdirSync as mkdirSync7, readFileSync as readFileSync7, readdirSync } from "node:fs";
import { dirname as dirname4, join as join12 } from "node:path";
import { homedir as homedir10 } from "node:os";
var log3 = (msg) => log("usage-tracker", msg);
function statsFilePath() {
  return join12(homedir10(), ".deeplake", "usage-stats.jsonl");
}
function ensureStatsDir() {
  const dir = dirname4(statsFilePath());
  if (!existsSync8(dir))
    mkdirSync7(dir, { recursive: true });
}
function appendUsageRecord(record) {
  try {
    ensureStatsDir();
    appendFileSync4(statsFilePath(), JSON.stringify(record) + "\n", "utf-8");
    log3(`appended record session=${record.sessionId} memBytes=${record.memorySearchBytes} memCount=${record.memorySearchCount}`);
  } catch (e) {
    log3(`appendUsageRecord failed: ${e?.message ?? String(e)}`);
  }
}

// dist/src/hooks/session-end.js
var log4 = (msg) => log("session-end", msg);
function recordSessionUsage(transcriptPath, sessionId) {
  if (!transcriptPath)
    return;
  try {
    const record = parseTranscript(transcriptPath, sessionId);
    if (record.memorySearchCount === 0 && record.memorySearchBytes === 0) {
      log4(`no memory searches in session ${sessionId} \u2014 skipping usage record`);
      return;
    }
    appendUsageRecord(record);
  } catch (e) {
    log4(`recordSessionUsage failed: ${e?.message ?? String(e)}`);
  }
}
async function main() {
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  if (process.env.HIVEMIND_CAPTURE === "false")
    return;
  const input = await readStdin();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId)
    return;
  const config = loadConfig();
  if (!config) {
    log4("no config");
    return;
  }
  recordSessionUsage(input.transcript_path, sessionId);
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`SessionEnd: periodic worker already running for ${sessionId}, skipping`);
    return;
  }
  wikiLog(`SessionEnd: triggering summary for ${sessionId}`);
  try {
    spawnWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "SessionEnd"
    });
  } catch (e) {
    log4(`spawn failed: ${e.message}`);
    try {
      releaseLock(sessionId);
    } catch (releaseErr) {
      log4(`releaseLock after spawn failure also failed: ${releaseErr.message}`);
    }
    throw e;
  }
  forceSessionEndTrigger({
    config,
    cwd,
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    agent: "claude_code",
    sessionId
  });
}
main().catch((e) => {
  log4(`fatal: ${e.message}`);
  process.exit(0);
});
