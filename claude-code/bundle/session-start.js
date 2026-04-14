#!/usr/bin/env node

// dist/src/hooks/session-start.js
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";
import { readFileSync as readFileSync2 } from "node:fs";

// dist/src/commands/auth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/session-start.js
var log2 = (msg) => log("session-start", msg);
var __bundleDir = dirname(fileURLToPath(import.meta.url));
var AUTH_CMD = join3(__bundleDir, "commands", "auth-login.js");
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
- node "DEEPLAKE_AUTH_CMD" login                              \u2014 SSO login
- node "DEEPLAKE_AUTH_CMD" whoami                             \u2014 show current user/org
- node "DEEPLAKE_AUTH_CMD" org list                           \u2014 list organizations
- node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>            \u2014 switch organization
- node "DEEPLAKE_AUTH_CMD" workspaces                         \u2014 list workspaces
- node "DEEPLAKE_AUTH_CMD" workspace <id>                     \u2014 switch workspace
- node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  \u2014 invite member (ALWAYS ask user which role before inviting)
- node "DEEPLAKE_AUTH_CMD" members                            \u2014 list members
- node "DEEPLAKE_AUTH_CMD" remove <user-id>                   \u2014 remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;
function getInstalledVersion() {
  let dir = __bundleDir;
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
async function main() {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1")
    return;
  await readStdin();
  const creds = loadCredentials();
  if (!creds?.token) {
    log2("no credentials found \u2014 run /hivemind:login to authenticate");
  } else {
    log2(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }
  let versionNotice = "";
  const current = getInstalledVersion();
  if (current) {
    versionNotice = `

Hivemind v${current}`;
  }
  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token ? `${resolvedContext}

Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}` : `${resolvedContext}

\u26A0\uFE0F Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${versionNotice}`;
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
