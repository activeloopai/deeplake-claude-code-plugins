#!/usr/bin/env node

/**
 * SessionStart async setup hook:
 * Runs server-side operations (table creation, placeholder, version check)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log, utcTimestamp } from "../utils/debug.js";
import { isDirectRun } from "../utils/direct-run.js";
import {
  drainSessionQueues,
  isSessionWriteAuthError,
  isSessionWriteDisabled,
  markSessionWriteDisabled,
} from "./session-queue.js";
import {
  getInstalledVersion,
  getLatestVersionCached,
  isNewer,
} from "./version-check.js";

const log = (msg: string) => _log("session-setup", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
const VERSION_CHECK_TIMEOUT = 3000;

const HOME = homedir();
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

export function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

export interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

export async function createPlaceholder(
  api: DeeplakeApi,
  table: string,
  sessionId: string,
  cwd: string,
  userName: string,
  orgName: string,
  workspaceId: string,
): Promise<void> {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;

  const existing = await api.query(
    `SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`
  );
  if (existing.length > 0) {
    wikiLog(`SessionSetup: summary exists for ${sessionId} (resumed)`);
    return;
  }

  const now = new Date().toISOString();
  const projectName = cwd.split("/").pop() ?? "unknown";
  const sessionSource = `/sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`;
  const content = [
    `# Session ${sessionId}`,
    `- **Source**: ${sessionSource}`,
    `- **Started**: ${now}`,
    `- **Project**: ${projectName}`,
    `- **Status**: in-progress`,
    "",
  ].join("\n");
  const filename = `${sessionId}.md`;

  await api.query(
    `INSERT INTO "${table}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '${sqlStr(summaryPath)}', '${sqlStr(filename)}', E'${sqlStr(content)}', '${sqlStr(userName)}', 'text/markdown', ` +
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'claude_code', '${now}', '${now}')`
  );

  wikiLog(`SessionSetup: created placeholder for ${sessionId} (${cwd})`);
}

interface SessionStartSetupDeps {
  wikiWorker?: boolean;
  creds?: ReturnType<typeof loadCredentials>;
  saveCredentialsFn?: typeof saveCredentials;
  config?: ReturnType<typeof loadConfig>;
  createApi?: (config: NonNullable<ReturnType<typeof loadConfig>>) => DeeplakeApi;
  captureEnabled?: boolean;
  drainSessionQueuesFn?: typeof drainSessionQueues;
  isSessionWriteDisabledFn?: typeof isSessionWriteDisabled;
  isSessionWriteAuthErrorFn?: typeof isSessionWriteAuthError;
  markSessionWriteDisabledFn?: typeof markSessionWriteDisabled;
  createPlaceholderFn?: typeof createPlaceholder;
  getInstalledVersionFn?: typeof getInstalledVersion;
  getLatestVersionCachedFn?: typeof getLatestVersionCached;
  isNewerFn?: typeof isNewer;
  execSyncFn?: typeof execSync;
  logFn?: (msg: string) => void;
  wikiLogFn?: typeof wikiLog;
}

export async function runSessionStartSetup(input: SessionStartInput, deps: SessionStartSetupDeps = {}): Promise<{
  status: "skipped" | "no_credentials" | "complete";
}> {
  const {
    wikiWorker = (process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1",
    creds = loadCredentials(),
    saveCredentialsFn = saveCredentials,
    config = loadConfig(),
    createApi = (activeConfig) => new DeeplakeApi(
      activeConfig.token,
      activeConfig.apiUrl,
      activeConfig.orgId,
      activeConfig.workspaceId,
      activeConfig.tableName,
    ),
    captureEnabled = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false",
    drainSessionQueuesFn = drainSessionQueues,
    isSessionWriteDisabledFn = isSessionWriteDisabled,
    isSessionWriteAuthErrorFn = isSessionWriteAuthError,
    markSessionWriteDisabledFn = markSessionWriteDisabled,
    createPlaceholderFn = createPlaceholder,
    getInstalledVersionFn = getInstalledVersion,
    getLatestVersionCachedFn = getLatestVersionCached,
    isNewerFn = isNewer,
    execSyncFn = execSync,
    logFn = log,
    wikiLogFn = wikiLog,
  } = deps;

  if (wikiWorker) return { status: "skipped" };
  if (!creds?.token) {
    logFn("no credentials");
    return { status: "no_credentials" };
  }

  if (!creds.userName) {
    try {
      const { userInfo } = await import("node:os");
      creds.userName = userInfo().username ?? "unknown";
      saveCredentialsFn(creds);
      logFn(`backfilled userName: ${creds.userName}`);
    } catch { /* non-fatal */ }
  }

  if (input.session_id && config) {
    try {
      const api = createApi(config);
      await api.ensureTable();
      if (captureEnabled) {
        if (isSessionWriteDisabledFn(config.sessionsTableName)) {
          logFn(`sessions table disabled, skipping setup for "${config.sessionsTableName}"`);
        } else {
          try {
            await api.ensureSessionsTable(config.sessionsTableName);
            const drain = await drainSessionQueuesFn(api, {
              sessionsTable: config.sessionsTableName,
            });
            if (drain.flushedSessions > 0) {
              logFn(`drained ${drain.flushedSessions} queued session(s), rows=${drain.rows}, batches=${drain.batches}`);
            }
          } catch (e: any) {
            if (isSessionWriteAuthErrorFn(e)) {
              markSessionWriteDisabledFn(config.sessionsTableName, e.message);
              logFn(`sessions table unavailable, skipping setup: ${e.message}`);
            } else {
              throw e;
            }
          }
        }
        await createPlaceholderFn(api, config.tableName, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
      }
      logFn("setup complete");
    } catch (e: any) {
      logFn(`setup failed: ${e.message}`);
      wikiLogFn(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }

  const autoupdate = creds.autoupdate !== false;
  try {
    const current = getInstalledVersionFn(__bundleDir, ".claude-plugin");
    if (current) {
      const latest = await getLatestVersionCachedFn({
        url: GITHUB_RAW_PKG,
        timeoutMs: VERSION_CHECK_TIMEOUT,
      });
      if (latest && isNewerFn(latest, current)) {
        if (autoupdate) {
          logFn(`autoupdate: updating ${current} → ${latest}`);
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes
              .map(s => `claude plugin update hivemind@hivemind --scope ${s} 2>/dev/null`)
              .join("; ");
            execSyncFn(cmd, { stdio: "ignore", timeout: 60_000 });
            process.stderr.write(`✅ Hivemind auto-updated: ${current} → ${latest}. Run /reload-plugins to apply.\n`);
            logFn(`autoupdate succeeded: ${current} → ${latest}`);
          } catch (e: any) {
            process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Auto-update failed — run /hivemind:update to upgrade manually.\n`);
            logFn(`autoupdate failed: ${e.message}`);
          }
        } else {
          process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Run /hivemind:update to upgrade.\n`);
          logFn(`update available (autoupdate off): ${current} → ${latest}`);
        }
      } else {
        logFn(`version up to date: ${current}`);
      }
    }
  } catch (e: any) {
    logFn(`version check failed: ${e.message}`);
  }

  return { status: "complete" };
}

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  await runSessionStartSetup(input);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
