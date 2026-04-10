#!/usr/bin/env node

/**
 * Session prune CLI — scoped cleanup of session data by the logged-in author.
 *
 * Usage:
 *   hivemind sessions prune                          — list pruneable sessions (dry run)
 *   hivemind sessions prune --before 2026-04-01      — delete sessions older than date
 *   hivemind sessions prune --session-id <id>        — delete a specific session
 *   hivemind sessions prune --all                    — delete all own sessions
 *   hivemind sessions prune ... --yes                — skip confirmation prompt
 */

import { loadConfig, type Config } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr, sqlLike } from "../utils/sql.js";
import { createInterface } from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionInfo {
  path: string;
  rowCount: number;
  firstEvent: string;
  lastEvent: string;
  project: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  before?: string;
  sessionId?: string;
  all: boolean;
  yes: boolean;
} {
  let before: string | undefined;
  let sessionId: string | undefined;
  let all = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--before" && argv[i + 1]) {
      before = argv[++i];
    } else if (arg === "--session-id" && argv[i + 1]) {
      sessionId = argv[++i];
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    }
  }

  return { before, sessionId, all, yes };
}

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`${message} [y/N] `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Extract session ID from a session path.
 * Path format: /sessions/<user>/<user>_<org>_<workspace>_<sessionId>.jsonl
 */
function extractSessionId(path: string): string {
  const filename = path.split("/").pop() ?? "";
  // Remove .jsonl, then take the last segment after the third underscore
  const base = filename.replace(/\.jsonl$/, "");
  const parts = base.split("_");
  // session ID is everything after <user>_<org>_<workspace>_
  return parts.length >= 4 ? parts.slice(3).join("_") : base;
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function listSessions(
  api: DeeplakeApi,
  sessionsTable: string,
  author: string,
): Promise<SessionInfo[]> {
  const rows = await api.query(
    `SELECT path, COUNT(*) as cnt, MIN(creation_date) as first_event, ` +
    `MAX(creation_date) as last_event, MAX(project) as project ` +
    `FROM "${sessionsTable}" WHERE author = '${sqlStr(author)}' ` +
    `GROUP BY path ORDER BY first_event DESC`
  );

  return rows.map(r => ({
    path: String(r.path),
    rowCount: Number(r.cnt),
    firstEvent: String(r.first_event),
    lastEvent: String(r.last_event),
    project: String(r.project ?? ""),
  }));
}

async function deleteSessions(
  config: Config,
  sessionPaths: string[],
): Promise<{ sessionsDeleted: number; summariesDeleted: number }> {
  if (sessionPaths.length === 0) return { sessionsDeleted: 0, summariesDeleted: 0 };

  const sessionsApi = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId,
    config.sessionsTableName,
  );
  const memoryApi = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId,
    config.tableName,
  );

  let sessionsDeleted = 0;
  let summariesDeleted = 0;

  for (const sessionPath of sessionPaths) {
    // Delete all rows for this session from the sessions table
    await sessionsApi.query(
      `DELETE FROM "${config.sessionsTableName}" WHERE path = '${sqlStr(sessionPath)}'`
    );
    sessionsDeleted++;

    // Delete the corresponding summary from the memory table
    // Summary path: /summaries/<user>/<sessionId>.md
    const sessionId = extractSessionId(sessionPath);
    const summaryPath = `/summaries/${config.userName}/${sessionId}.md`;

    const existing = await memoryApi.query(
      `SELECT path FROM "${config.tableName}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`
    );
    if (existing.length > 0) {
      await memoryApi.query(
        `DELETE FROM "${config.tableName}" WHERE path = '${sqlStr(summaryPath)}'`
      );
      summariesDeleted++;
    }
  }

  return { sessionsDeleted, summariesDeleted };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function sessionPrune(argv: string[]): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error("Not logged in. Run: deeplake login");
    process.exit(1);
  }

  const { before, sessionId, all, yes } = parseArgs(argv);
  const author = config.userName;

  const sessionsApi = new DeeplakeApi(
    config.token, config.apiUrl, config.orgId, config.workspaceId,
    config.sessionsTableName,
  );

  // Fetch all sessions for this author
  const sessions = await listSessions(sessionsApi, config.sessionsTableName, author);

  if (sessions.length === 0) {
    console.log(`No sessions found for author "${author}".`);
    return;
  }

  // Filter based on flags
  let targets: SessionInfo[];

  if (sessionId) {
    targets = sessions.filter(s => extractSessionId(s.path) === sessionId);
    if (targets.length === 0) {
      console.error(`Session not found: ${sessionId}`);
      console.error(`\nYour sessions:`);
      for (const s of sessions.slice(0, 10)) {
        console.error(`  ${extractSessionId(s.path)}  ${s.firstEvent.slice(0, 10)}  ${s.project}`);
      }
      process.exit(1);
    }
  } else if (before) {
    const cutoff = new Date(before);
    if (isNaN(cutoff.getTime())) {
      console.error(`Invalid date: ${before}`);
      process.exit(1);
    }
    targets = sessions.filter(s => new Date(s.lastEvent) < cutoff);
  } else if (all) {
    targets = sessions;
  } else {
    // Dry run — just list sessions
    console.log(`Sessions for "${author}" (${sessions.length} total):\n`);
    console.log("  Session ID".padEnd(42) + "Date".padEnd(14) + "Events".padEnd(10) + "Project");
    console.log("  " + "─".repeat(80));
    for (const s of sessions) {
      const id = extractSessionId(s.path);
      const date = s.firstEvent.slice(0, 10);
      console.log(`  ${id.padEnd(40)}${date.padEnd(14)}${String(s.rowCount).padEnd(10)}${s.project}`);
    }
    console.log(`\nTo delete, use: --all, --before <date>, or --session-id <id>`);
    return;
  }

  if (targets.length === 0) {
    console.log("No sessions match the given criteria.");
    return;
  }

  // Show what will be deleted
  console.log(`Will delete ${targets.length} session(s) for "${author}":\n`);
  for (const s of targets) {
    const id = extractSessionId(s.path);
    console.log(`  ${id}  ${s.firstEvent.slice(0, 10)}  ${s.rowCount} events  ${s.project}`);
  }
  console.log();

  // Confirm unless --yes
  if (!yes) {
    const ok = await confirm("Proceed with deletion?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const { sessionsDeleted, summariesDeleted } = await deleteSessions(
    config,
    targets.map(t => t.path),
  );

  console.log(`Deleted ${sessionsDeleted} session(s) and ${summariesDeleted} summary file(s).`);
}
