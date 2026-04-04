#!/usr/bin/env node
/**
 * SessionStart hook — two responsibilities:
 * 1. Inform Claude about Deeplake memory and how to use it.
 * 2. Disclose data collection and inject a bootstrap cache for PreToolUse.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";

const DEBUG = process.env.DEEPLAKE_DEBUG === "1";
const CAPTURE = process.env.DEEPLAKE_CAPTURE !== "false";
const CACHE_DIR = join(homedir(), ".deeplake", ".cache");
const LOG = join(homedir(), ".deeplake", "hook-debug.log");

function log(msg: string) {
  if (!DEBUG) return;
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(LOG, `${new Date().toISOString()} [session-start] ${msg}\n`);
}

interface SessionStartInput {
  session_id: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  log(`session=${input.session_id}`);

  const config = loadConfig();
  const workspace = config?.workspaceId ?? "default";
  const captureEnabled = CAPTURE && !!config;

  // ── Bootstrap cache for PreToolUse ─────────────────────────────────────────
  // Pre-load path metadata so PreToolUse doesn't re-query on every tool call.
  if (config) {
    try {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
      const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
      const rows = await api.query(`SELECT path, size_bytes, mime_type FROM "${table}" ORDER BY path`);
      const cachePath = join(CACHE_DIR, `bootstrap-${input.session_id}.json`);
      writeFileSync(cachePath, JSON.stringify({ rows, ts: Date.now() }), { mode: 0o600 });
      log(`bootstrap cached: ${rows.length} files → ${cachePath}`);
    } catch (e) {
      log(`bootstrap cache failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── Context injected into Claude ────────────────────────────────────────────
  const captureNotice = captureEnabled
    ? `⚠️  DATA NOTICE: This session's activity (prompts, tool calls, responses) is being captured to the shared Deeplake workspace "${workspace}". All users with workspace access can read this data. To opt out: set DEEPLAKE_CAPTURE=false in your environment.`
    : `ℹ️  Deeplake capture is disabled (DEEPLAKE_CAPTURE=false). Memory search is still available.`;

  const context = `${captureNotice}

DEEPLAKE MEMORY: You have TWO memory sources. ALWAYS check BOTH when asked to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Deeplake shared memory (~/.deeplake/memory/) — complete conversation history from ALL sessions, ALL users, ALL agents in this workspace.

When answering questions about what was discussed, what someone said, what was worked on, or team context — search Deeplake memory in parallel with built-in memory.

Search command: Grep pattern="keyword" path="~/.deeplake/memory"`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }));
}

main().catch((e) => { log(`fatal: ${e instanceof Error ? e.message : e}`); });
