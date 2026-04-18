#!/usr/bin/env node

// dist/src/hooks/session-start.js
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join4 } from "node:path";

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
var CONFIG_DIR = join(homedir(), ".deeplake");
var CREDS_PATH = join(CONFIG_DIR, "credentials.json");
function loadCredentials() {
  if (!existsSync(CREDS_PATH))
    return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveCredentials(creds) {
  if (!existsSync(CONFIG_DIR))
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(CREDS_PATH, JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), { mode: 384 });
}

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

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEBUG = (process.env.HIVEMIND_DEBUG ?? process.env.DEEPLAKE_DEBUG) === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/version-check.js
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var DEFAULT_VERSION_CACHE_PATH = join3(homedir3(), ".deeplake", ".version-check.json");
var DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1e3;
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join3(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync2(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join3(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync2(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version)
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
function isNewer(latest, current) {
  const parse = (v) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || la === ca && lb > cb || la === ca && lb === cb && lc > cc;
}
function readVersionCache(cachePath = DEFAULT_VERSION_CACHE_PATH) {
  if (!existsSync2(cachePath))
    return null;
  try {
    const parsed = JSON.parse(readFileSync2(cachePath, "utf-8"));
    if (parsed && typeof parsed.checkedAt === "number" && typeof parsed.url === "string" && (typeof parsed.latest === "string" || parsed.latest === null)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function readFreshCachedLatestVersion(url, ttlMs = DEFAULT_VERSION_CACHE_TTL_MS, cachePath = DEFAULT_VERSION_CACHE_PATH, nowMs = Date.now()) {
  const cached = readVersionCache(cachePath);
  if (!cached || cached.url !== url)
    return void 0;
  if (nowMs - cached.checkedAt > ttlMs)
    return void 0;
  return cached.latest;
}

// dist/src/hooks/session-start.js
var log2 = (msg) => log("session-start", msg);
var __bundleDir = dirname2(fileURLToPath(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) \u2014 personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) \u2014 global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md \u2014 START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md \u2014 AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl \u2014 raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management \u2014 each argument is SEPARATE (do NOT quote subcommands together):
- node "HIVEMIND_AUTH_CMD" login                              \u2014 SSO login
- node "HIVEMIND_AUTH_CMD" whoami                             \u2014 show current user/org
- node "HIVEMIND_AUTH_CMD" org list                           \u2014 list organizations
- node "HIVEMIND_AUTH_CMD" org switch <name-or-id>            \u2014 switch organization
- node "HIVEMIND_AUTH_CMD" workspaces                         \u2014 list workspaces
- node "HIVEMIND_AUTH_CMD" workspace <id>                     \u2014 switch workspace
- node "HIVEMIND_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- node "HIVEMIND_AUTH_CMD" members                            \u2014 list members
- node "HIVEMIND_AUTH_CMD" remove <user-id>                   \u2014 remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
var GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
async function main() {
  if ((process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1")
    return;
  await readStdin();
  let creds = loadCredentials();
  if (!creds?.token) {
    log2("no credentials found \u2014 run /hivemind:login to authenticate");
  } else {
    log2(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "unknown";
        saveCredentials(creds);
        log2(`backfilled and persisted userName: ${creds.userName}`);
      } catch {
      }
    }
  }
  let updateNotice = "";
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  if (current) {
    const latest = readFreshCachedLatestVersion(GITHUB_RAW_PKG, DEFAULT_VERSION_CACHE_TTL_MS);
    if (latest && isNewer(latest, current)) {
      updateNotice = `

\u2B06\uFE0F Hivemind update available: ${current} \u2192 ${latest}.`;
    } else {
      updateNotice = `

\u2705 Hivemind v${current}`;
    }
  }
  const resolvedContext = context.replace(/HIVEMIND_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token ? `${resolvedContext}

Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${updateNotice}` : `${resolvedContext}

\u26A0\uFE0F Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${updateNotice}`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  }));
}
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
