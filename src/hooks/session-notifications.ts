#!/usr/bin/env node

/**
 * Claude Code SessionStart hook entry point — notifications channel.
 *
 * Wired as a SECOND SessionStart hook command in claude-code/hooks/hooks.json,
 * alongside the existing memory/hivemind hook (session-start.js).
 *
 * Bundle target: bundle/session-notifications.js. See esbuild.config.mjs.
 *
 * Failure isolation: any error here is swallowed and the process exits 0.
 * The sibling memory/hivemind hook is not affected.
 */

import { loadCredentials } from "../commands/auth.js";
import { readStdin } from "../utils/stdin.js";
import { drainSessionStart, registerRule } from "../notifications/index.js";
import { welcomeRule } from "../notifications/rules/welcome.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("session-notifications", msg);

// Register the v1 rule set. Rules are pure functions; registration is cheap.
registerRule(welcomeRule);

interface SessionStartInput {
  session_id?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  // Skip if this is a sub-session spawned by the wiki worker — same guard
  // as session-start.ts. Avoids duplicate work for nested invocations.
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  // Drain stdin so Claude Code's writer doesn't EPIPE. We also extract
  // session_id so the local-usage source can scope its dedupKey to the
  // current session — two parallel hook fires for the same session share
  // the same id and dedupe to one emission via the atomic claim file.
  const input = await readStdin<SessionStartInput>().catch(() => ({} as SessionStartInput));
  // Trim + non-empty check: an empty or whitespace-only session_id would
  // collapse the dedupKey across unrelated sessions. fetchLocalUsageNotifications
  // already returns [] when sessionId is undefined; route there instead of
  // letting an empty string slip through.
  const rawSessionId = typeof input?.session_id === "string" ? input.session_id.trim() : "";
  const sessionId = rawSessionId.length > 0 ? rawSessionId : undefined;

  const creds = loadCredentials();
  await drainSessionStart({ agent: "claude-code", creds, sessionId });
}

main().catch((e) => { log(`fatal: ${e?.message ?? String(e)}`); process.exit(0); });
