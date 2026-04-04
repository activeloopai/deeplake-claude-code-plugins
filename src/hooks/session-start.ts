#!/usr/bin/env node

/**
 * SessionStart hook:
 * 1. If no credentials → run device flow login (opens browser)
 * 2. Inject Deeplake memory instructions into Claude's context
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials, login } from "../commands/auth.js";
import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

const context = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory is broader — it has full conversation history (every message, response, and tool call), team activity, and cross-session context that your built-in memory may not have.

IMPORTANT: When answering questions about what was discussed, what someone said, what was worked on, team context, or any factual recall — search Deeplake memory in parallel with your built-in memory. Do not skip it. Do not wait to be asked.

Deeplake memory is especially useful for:
- Cross-session history ("what did we discuss last time?")
- Team/org context ("what is the team working on?")
- Full conversation replay ("what exactly did I say about X?")

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management (DEEPLAKE_AUTH_CMD will be replaced with actual path below):
- Switch org: node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>
- List orgs: node "DEEPLAKE_AUTH_CMD" org list
- Invite member: node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>
- List members: node "DEEPLAKE_AUTH_CMD" members
- Re-login: node "DEEPLAKE_AUTH_CMD" login

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty, you may retry once. If results are still unavailable after a few attempts, report what you found and move on.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

async function main(): Promise<void> {
  let creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found, starting device flow login");
    try {
      creds = await login();
      log(`login ok: org=${creds.orgName ?? creds.orgId}`);
    } catch (e: any) {
      log(`login failed: ${e.message}`);
      // Still inject context — memory search won't work but other features will
    }
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  const resolvedContext = context.replace(/DEEPLAKE_AUTH_CMD/g, AUTH_CMD);
  const additionalContext = creds?.token
    ? `${resolvedContext}\n\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})`
    : `${resolvedContext}\n\n⚠️ Not logged in to Deeplake. Memory search will not work. Ask the user to run /deeplake:deeplake-login.`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
