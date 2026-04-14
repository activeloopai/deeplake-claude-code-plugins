#!/usr/bin/env node

/**
 * SessionStart hook (fast path):
 * Only reads local credentials and injects context into Claude's system prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { loadCredentials } from "../commands/auth.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md — START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md — AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl — raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management — each argument is SEPARATE (do NOT quote subcommands together):
- node "DEEPLAKE_AUTH_CMD" login                              — SSO login
- node "DEEPLAKE_AUTH_CMD" whoami                             — show current user/org
- node "DEEPLAKE_AUTH_CMD" org list                           — list organizations
- node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>            — switch organization
- node "DEEPLAKE_AUTH_CMD" workspaces                         — list workspaces
- node "DEEPLAKE_AUTH_CMD" workspace <id>                     — switch workspace
- node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  — invite member (ALWAYS ask user which role before inviting)
- node "DEEPLAKE_AUTH_CMD" members                            — list members
- node "DEEPLAKE_AUTH_CMD" remove <user-id>                   — remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

function getInstalledVersion(): string | null {
  let dir = __bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version) return pkg.version;
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;

  await readStdin<SessionStartInput>();

  const creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run /hivemind:login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Local-only version display (no network call — actual update runs in async setup hook)
  let versionNotice = "";
  const current = getInstalledVersion();
  if (current) {
    versionNotice = `\n\nHivemind v${current}`;
  }

  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token
    ? `${resolvedContext}\n\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${resolvedContext}\n\n⚠️ Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${versionNotice}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
