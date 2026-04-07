#!/usr/bin/env node

/**
 * SessionStart hook:
 * 1. If no credentials → run device flow login (opens browser)
 * 2. Inject Deeplake memory instructions into Claude's context
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadCredentials, login } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { DeeplakeFs } from "../shell/deeplake-fs.js";
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
- ~/.deeplake/memory/summaries/*.md — AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl — raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management (DEEPLAKE_AUTH_CMD will be replaced with actual path below):
- Switch org: node "DEEPLAKE_AUTH_CMD" org switch <name-or-id>
- List orgs: node "DEEPLAKE_AUTH_CMD" org list
- Invite member: node "DEEPLAKE_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>
- List members: node "DEEPLAKE_AUTH_CMD" members
- Re-login: node "DEEPLAKE_AUTH_CMD" login

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set DEEPLAKE_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

const HOME = homedir();
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}\n`);
  } catch { /* ignore */ }
}

async function createPlaceholder(fs: DeeplakeFs, sessionId: string, cwd: string): Promise<void> {
  // Ensure directories
  try { await fs.mkdir("/summaries"); } catch { /* exists */ }
  try { await fs.mkdir("/sessions"); } catch { /* exists */ }

  // Bootstrap index if missing
  const indexExists = await fs.exists("/index.md");
  if (!indexExists) {
    await fs.writeFile("/index.md", [
      "# Session Index",
      "",
      "List of all Claude Code sessions with summaries.",
      "",
      "| Session | Date | Project | Description |",
      "|---------|------|---------|-------------|",
      "",
    ].join("\n"));
    wikiLog("Created index.md");
  }

  const summaryPath = `/summaries/${sessionId}.md`;
  const summaryExists = await fs.exists(summaryPath);

  if (!summaryExists) {
    const now = new Date().toISOString();
    await fs.writeFile(summaryPath, [
      `# Session ${sessionId}`,
      `- **Started**: ${now}`,
      `- **Project**: ${cwd}`,
      `- **Status**: in-progress`,
      "",
    ].join("\n"));

    // Append to index
    const shortDate = now.slice(0, 10);
    const projectName = cwd.split("/").pop() ?? "unknown";
    await fs.appendFile("/index.md", `| [${sessionId}](summaries/${sessionId}.md) | ${shortDate} | ${projectName} | in progress |\n`);
    await fs.flush();

    wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
  } else {
    wikiLog(`SessionStart: summary exists for ${sessionId} (resumed)`);
  }
}

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();

  let creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — skipping auth (non-blocking)");
    // Don't block session start with interactive auth.
    // Claude will be told to ask the user to log in.
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    // Backfill userName if missing (for users who logged in before this field was added)
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "user";
        log(`backfilled userName: ${creds.userName}`);
      } catch { /* non-fatal */ }
    }
  }

  // Create placeholder summary + index entry via Deeplake API
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        const fs = await DeeplakeFs.create(api, table, "/");
        await createPlaceholder(fs, input.session_id, input.cwd ?? "");
        log("placeholder created");
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
    }
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
