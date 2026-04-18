#!/usr/bin/env node

/**
 * SessionStart hook:
 * 1. If no credentials → run device flow login (opens browser)
 * 2. Inject Deeplake memory instructions into Claude's context
 *
 * This sync hook stays local-only. All network work (table setup, placeholder,
 * queue drain, version refresh, auto-update) runs in session-start-setup.ts.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { isDirectRun } from "../utils/direct-run.js";
import {
  DEFAULT_VERSION_CACHE_TTL_MS,
  getInstalledVersion,
  isNewer,
  readFreshCachedLatestVersion,
} from "./version-check.js";

const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

export const CLAUDE_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake global memory (~/.deeplake/memory/) — global memory shared across all sessions, users, and agents in the org

Deeplake memory structure:
- ~/.deeplake/memory/index.md — START HERE, table of all sessions
- ~/.deeplake/memory/summaries/username/*.md — AI-generated wiki summaries per session
- ~/.deeplake/memory/sessions/username/*.jsonl — raw session data (last resort)

SEARCH STRATEGY: Always read index.md first. Then read specific summaries. Only read raw JSONL if summaries don't have enough detail. Do NOT jump straight to JSONL files.
When index.md points to a likely match, read that exact summary or session file directly before trying broader grep variants.
For benchmark-style paths like conv_0_session_*.json or named session summaries, open the exact file from index.md instead of probing synonym guesses like "partner", "boyfriend", "married", etc.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots when the question is about Deeplake memory.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"

Organization management — each argument is SEPARATE (do NOT quote subcommands together):
- node "HIVEMIND_AUTH_CMD" login                              — SSO login
- node "HIVEMIND_AUTH_CMD" whoami                             — show current user/org
- node "HIVEMIND_AUTH_CMD" org list                           — list organizations
- node "HIVEMIND_AUTH_CMD" org switch <name-or-id>            — switch organization
- node "HIVEMIND_AUTH_CMD" workspaces                         — list workspaces
- node "HIVEMIND_AUTH_CMD" workspace <id>                     — switch workspace
- node "HIVEMIND_AUTH_CMD" invite <email> <ADMIN|WRITE|READ>  — invite member (ALWAYS ask user which role before inviting)
- node "HIVEMIND_AUTH_CMD" members                            — list members
- node "HIVEMIND_AUTH_CMD" remove <user-id>                   — remove member

IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash commands and standard text-processing tools (awk, sed, jq, grep, etc.).

LIMITS: Do NOT spawn subagents to read deeplake memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set HIVEMIND_DEBUG=1 to enable verbose logging to ~/.deeplake/hook-debug.log`;

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";

export function buildSessionStartAdditionalContext(args: {
  authCommand: string;
  creds: ReturnType<typeof loadCredentials>;
  currentVersion: string | null;
  latestVersion: string | null;
}): string {
  const resolvedContext = CLAUDE_SESSION_START_CONTEXT.replace(/HIVEMIND_AUTH_CMD/g, args.authCommand);

  let updateNotice = "";
  if (args.currentVersion) {
    if (args.latestVersion && isNewer(args.latestVersion, args.currentVersion)) {
      updateNotice = `\n\n⬆️ Hivemind update available: ${args.currentVersion} → ${args.latestVersion}.`;
    } else {
      updateNotice = `\n\n✅ Hivemind v${args.currentVersion}`;
    }
  }

  return args.creds?.token
    ? `${resolvedContext}\n\nLogged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${updateNotice}`
    : `${resolvedContext}\n\n⚠️ Not logged in to Deeplake. Memory search will not work. Ask the user to run /hivemind:login to authenticate.${updateNotice}`;
}

interface SessionStartHookDeps {
  wikiWorker?: boolean;
  creds?: ReturnType<typeof loadCredentials>;
  saveCredentialsFn?: typeof saveCredentials;
  currentVersion?: string | null;
  latestVersion?: string | null;
  authCommand?: string;
  bundleDir?: string;
  logFn?: (msg: string) => void;
}

export async function runSessionStartHook(_input: Record<string, unknown>, deps: SessionStartHookDeps = {}): Promise<{
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
} | null> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    creds = loadCredentials(),
    saveCredentialsFn = saveCredentials,
    currentVersion = getInstalledVersion(__bundleDir, ".claude-plugin"),
    latestVersion = currentVersion
      ? readFreshCachedLatestVersion(GITHUB_RAW_PKG, DEFAULT_VERSION_CACHE_TTL_MS) ?? null
      : null,
    authCommand = AUTH_CMD,
    logFn = log,
  } = deps;

  if (wikiWorker) return null;

  if (!creds?.token) {
    logFn("no credentials found — run /hivemind:login to authenticate");
  } else {
    logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "unknown";
        saveCredentialsFn(creds);
        logFn(`backfilled and persisted userName: ${creds.userName}`);
      } catch { /* non-fatal */ }
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildSessionStartAdditionalContext({
        authCommand,
        creds,
        currentVersion,
        latestVersion,
      }),
    },
  };
}

async function main(): Promise<void> {
  await readStdin<Record<string, unknown>>();
  const result = await runSessionStartHook({});
  if (result) console.log(JSON.stringify(result));
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
