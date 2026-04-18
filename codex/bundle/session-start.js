#!/usr/bin/env node

// dist/src/hooks/codex/session-start.js
import { spawn } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
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

// dist/src/utils/stdin.js
function readStdin() {
  return new Promise((resolve2, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve2(JSON.parse(data));
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

// dist/src/utils/direct-run.js
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch {
    return false;
  }
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

// dist/src/hooks/codex/session-start.js
var log2 = (msg) => log("codex-session-start", msg);
var __bundleDir = dirname2(fileURLToPath2(import.meta.url));
var AUTH_CMD = join4(__bundleDir, "commands", "auth-login.js");
var CODEX_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) \u2192 summaries/*.md \u2192 sessions/{author}/* (last resort). Do NOT jump straight to raw session files.
When index.md identifies a likely match, read that exact summary or session path directly before broader grep variants.
If index.md already points to likely candidate files, open those exact files before broader synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots for Deeplake recall tasks.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked index.md plus at least one likely summary or raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters \u2014 they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;
function buildCodexSessionStartContext(args) {
  const versionNotice = args.currentVersion ? `
Hivemind v${args.currentVersion}` : "";
  return args.creds?.token ? `${CODEX_SESSION_START_CONTEXT}
Logged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${versionNotice}` : `${CODEX_SESSION_START_CONTEXT}
Not logged in to Deeplake. Run: node "${args.authCommand}" login${versionNotice}`;
}
async function runCodexSessionStartHook(input, deps = {}) {
  const { wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1", creds = loadCredentials(), spawnFn = spawn, currentVersion = getInstalledVersion(__bundleDir, ".codex-plugin"), authCommand = AUTH_CMD, setupScript = join4(__bundleDir, "session-start-setup.js"), logFn = log2 } = deps;
  if (wikiWorker)
    return null;
  if (!creds?.token)
    logFn("no credentials found \u2014 run auth login to authenticate");
  else
    logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  if (creds?.token) {
    const child = spawnFn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env }
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    logFn("spawned async setup process");
  }
  return buildCodexSessionStartContext({
    creds,
    currentVersion,
    authCommand
  });
}
async function main() {
  const input = await readStdin();
  const output = await runCodexSessionStartHook(input);
  if (output)
    console.log(output);
}
if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    log2(`fatal: ${e.message}`);
    process.exit(0);
  });
}
export {
  CODEX_SESSION_START_CONTEXT,
  buildCodexSessionStartContext,
  runCodexSessionStartHook
};
