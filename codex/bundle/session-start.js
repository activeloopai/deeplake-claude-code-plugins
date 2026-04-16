#!/usr/bin/env node

// dist/src/hooks/codex/session-start.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";
import { readFileSync as readFileSync2 } from "node:fs";

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
var DEBUG = process.env.HIVEMIND_DEBUG === "1";
var LOG = join2(homedir2(), ".deeplake", "hook-debug.log");
function log(tag, msg) {
  if (!DEBUG)
    return;
  appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
}

// dist/src/hooks/codex/session-start.js
var log2 = (msg) => log("codex-session-start", msg);
var __bundleDir = dirname(fileURLToPath(import.meta.url));
var AUTH_CMD = join3(__bundleDir, "commands", "auth-login.js");
var context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) \u2192 summaries/*.md \u2192 sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
function getInstalledVersion() {
  try {
    const pluginJson = join3(__bundleDir, "..", ".codex-plugin", "plugin.json");
    const plugin = JSON.parse(readFileSync2(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
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
  if (process.env.HIVEMIND_WIKI_WORKER === "1")
    return;
  const input = await readStdin();
  const creds = loadCredentials();
  if (!creds?.token) {
    log2("no credentials found \u2014 run auth login to authenticate");
  } else {
    log2(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }
  if (creds?.token) {
    const setupScript = join3(__bundleDir, "session-start-setup.js");
    const child = spawn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env }
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    log2("spawned async setup process");
  }
  let versionNotice = "";
  const current = getInstalledVersion();
  if (current) {
    versionNotice = `
Hivemind v${current}`;
  }
  const additionalContext = creds?.token ? `${context}
Logged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}` : `${context}
Not logged in to Deeplake. Run: node "${AUTH_CMD}" login${versionNotice}`;
  console.log(additionalContext);
}
main().catch((e) => {
  log2(`fatal: ${e.message}`);
  process.exit(0);
});
