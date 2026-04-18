#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { getInstalledVersion } from "../version-check.js";

const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

export const CODEX_SESSION_START_CONTEXT = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/{author}/* (last resort). Do NOT jump straight to raw session files.
When index.md identifies a likely match, read that exact summary or session path directly before broader grep variants.
If index.md already points to likely candidate files, open those exact files before broader synonym greps or wide exploratory scans.
Do NOT probe unrelated local paths such as ~/.claude/projects/, arbitrary home directories, or guessed summary roots for Deeplake recall tasks.
TEMPORAL GROUNDING: If a summary or transcript uses relative time like "last year", "last week", or "next month", resolve it against that session's own date/date_time metadata, not today's date.
TEMPORAL FOLLOW-THROUGH: If a summary only gives a relative time, open the linked source session and use its date/date_time to convert the final answer into an absolute month/date/year or explicit range before responding.
ANSWER SHAPE: Once you have enough evidence, answer with the smallest exact phrase supported by memory. For identity or relationship questions, use just the noun phrase. For "when" questions, prefer absolute dates/months/years over relative phrases. Avoid extra biography, explanation, or hedging.
NOT-FOUND BAR: Do NOT answer "not found" until you have checked index.md plus at least one likely summary or raw session file for the named person. If keyword grep is empty, grep the person's name alone and inspect the candidate files.
NEGATIVE-EVIDENCE QUESTIONS: For identity, relationship status, and research-topic questions, summaries may omit the exact phrase. If likely summaries are ambiguous, read the candidate raw session transcript and look for positive clues before concluding the answer is absent.
Search: grep -r "keyword" ~/.deeplake/memory/
IMPORTANT: Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory.`;

export interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

export function buildCodexSessionStartContext(args: {
  creds: ReturnType<typeof loadCredentials>;
  currentVersion: string | null;
  authCommand: string;
}): string {
  const versionNotice = args.currentVersion ? `\nHivemind v${args.currentVersion}` : "";
  return args.creds?.token
    ? `${CODEX_SESSION_START_CONTEXT}\nLogged in to Deeplake as org: ${args.creds.orgName ?? args.creds.orgId} (workspace: ${args.creds.workspaceId ?? "default"})${versionNotice}`
    : `${CODEX_SESSION_START_CONTEXT}\nNot logged in to Deeplake. Run: node "${args.authCommand}" login${versionNotice}`;
}

interface CodexSessionStartDeps {
  wikiWorker?: boolean;
  creds?: ReturnType<typeof loadCredentials>;
  spawnFn?: typeof spawn;
  currentVersion?: string | null;
  authCommand?: string;
  setupScript?: string;
  logFn?: (msg: string) => void;
}

export async function runCodexSessionStartHook(input: CodexSessionStartInput, deps: CodexSessionStartDeps = {}): Promise<string | null> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    creds = loadCredentials(),
    spawnFn = spawn,
    currentVersion = getInstalledVersion(__bundleDir, ".codex-plugin"),
    authCommand = AUTH_CMD,
    setupScript = join(__bundleDir, "session-start-setup.js"),
    logFn = log,
  } = deps;

  if (wikiWorker) return null;

  if (!creds?.token) logFn("no credentials found — run auth login to authenticate");
  else logFn(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);

  if (creds?.token) {
    const child = spawnFn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    logFn("spawned async setup process");
  }

  return buildCodexSessionStartContext({
    creds,
    currentVersion,
    authCommand,
  });
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexSessionStartInput>();
  const output = await runCodexSessionStartHook(input);
  if (output) console.log(output);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
