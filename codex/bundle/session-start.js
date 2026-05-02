#!/usr/bin/env node

// dist/src/hooks/codex/session-start.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join4 } from "node:path";

// dist/src/commands/auth.js
import { execSync } from "node:child_process";

// dist/src/commands/auth-creds.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

// dist/src/utils/version-check.js
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
function getInstalledVersion(bundleDir, pluginManifestDir) {
  try {
    const pluginJson = join3(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync2(pluginJson, "utf-8"));
    if (plugin.version)
      return plugin.version;
  } catch {
  }
  try {
    const stamp = readFileSync2(join3(bundleDir, "..", ".hivemind_version"), "utf-8").trim();
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
    const candidate = join3(dir, "package.json");
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

// dist/src/hooks/codex/session-start.js
var log2 = (msg) => log("codex-session-start", msg);
var __bundleDir = dirname2(fileURLToPath(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Deeplake memory has THREE tiers \u2014 pick the right one for the question:
1. ~/.deeplake/memory/index.md   \u2014 auto-generated index, top 50 most-recently-updated entries with Created + Last Updated + Project + Description columns. ~5 KB. **For "what's recent / who did X this week / since <date>" queries, START HERE** and trust the Last Updated column over any "Started:" line in summary bodies.
2. ~/.deeplake/memory/summaries/ \u2014 condensed wiki summaries per session (~3 KB each). For keyword/topic recall, search these.
3. ~/.deeplake/memory/sessions/  \u2014 raw full-dialogue JSONL (~5 KB each). FALLBACK only \u2014 use when summaries don't contain the exact quote/turn you need.

Search workflow:
- Time-based ("last week", "today", "since X"): cat ~/.deeplake/memory/index.md and read the most-recent rows.
- Keyword/topic recall: grep -r "keyword" ~/.deeplake/memory/summaries/ (the shell hook routes this through hybrid lexical+semantic search \u2014 synonyms match too). Then cat the top-matching summary.
- Raw transcript fallback only: grep -r "keyword" ~/.deeplake/memory/sessions/ (use sparingly \u2014 JSONL is verbose).

\u2705 grep -r "keyword" ~/.deeplake/memory/summaries/
\u274C grep without a summaries/ or sessions/ suffix \u2014 too noisy

IMPORTANT: Only use bash builtins (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) on ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
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
    const setupScript = join4(__bundleDir, "session-start-setup.js");
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
  const current = getInstalledVersion(__bundleDir, ".codex-plugin");
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
