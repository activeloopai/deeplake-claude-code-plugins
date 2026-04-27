#!/usr/bin/env node

/**
 * Codex SessionStart hook (fast path):
 * Only reads local credentials and injects context into Codex's developer prompt.
 * All server calls (table setup, placeholder, version check) are handled by
 * session-start-setup.js which runs as a separate async hook.
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model, source }
 * Codex output: plain text on stdout (added as developer context)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCredentials } from "../../commands/auth.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Deeplake memory has TWO tiers — search them IN THIS ORDER:
1. ~/.deeplake/memory/summaries/ — condensed wiki summaries (~3 KB each). START HERE: the answer to recall questions is usually in a summary.
2. ~/.deeplake/memory/sessions/  — raw full-dialogue JSONL (~5 KB each). Use as FALLBACK only if no summary matches.
3. ~/.deeplake/memory/index.md   — skip (too large).

Recall workflow:
1. grep -r "keyword" ~/.deeplake/memory/summaries/   ← FIRST
2. cat the top-matching summary(ies)
3. Only if no summary matches: grep -r "keyword" ~/.deeplake/memory/sessions/

✅ grep -r "keyword" ~/.deeplake/memory/summaries/
❌ grep without a summaries/ or sessions/ suffix — too noisy

IMPORTANT: Only use bash builtins (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) on ~/.deeplake/memory/. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem.
Do NOT spawn subagents to read deeplake memory. Never read index.md.`;

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  const creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run auth login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
  }

  // Spawn async setup (table creation, placeholder, version check) as detached process.
  // Codex doesn't support async hooks, so we use the same pattern as the wiki worker.
  if (creds?.token) {
    const setupScript = join(__bundleDir, "session-start-setup.js");
    const child = spawn("node", [setupScript], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env },
    });
    // Feed the same stdin input to the setup process
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
    child.unref();
    log("spawned async setup process");
  }

  let versionNotice = "";
  const current = getInstalledVersion(__bundleDir, ".codex-plugin");
  if (current) {
    versionNotice = `\nHivemind v${current}`;
  }

  const additionalContext = creds?.token
    ? `${context}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${versionNotice}`
    : `${context}\nNot logged in to Deeplake. Run: node "${AUTH_CMD}" login${versionNotice}`;

  // Codex SessionStart: plain text on stdout is added as developer context.
  // JSON { additionalContext } format is rejected by Codex 0.118.0.
  console.log(additionalContext);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
