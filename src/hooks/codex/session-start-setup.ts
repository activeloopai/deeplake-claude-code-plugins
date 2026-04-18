#!/usr/bin/env node

/**
 * Codex SessionStart async setup hook:
 * Runs server-side operations (table creation, placeholder, version check)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../../commands/auth.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import {
  drainSessionQueues,
  isSessionWriteAuthError,
  isSessionWriteDisabled,
  markSessionWriteDisabled,
} from "../session-queue.js";
import {
  getInstalledVersion,
  getLatestVersionCached,
  isNewer,
} from "../version-check.js";

const log = (msg: string) => _log("codex-session-setup", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
const VERSION_CHECK_TIMEOUT = 3000;

const HOME = homedir();
const WIKI_LOG = join(HOME, ".codex", "hooks", "deeplake-wiki.log");

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".codex", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}\n`);
  } catch { /* ignore */ }
}

/** Create a placeholder summary via direct SQL INSERT. */
async function createPlaceholder(api: DeeplakeApi, table: string, sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string): Promise<void> {
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
    `${Buffer.byteLength(content, "utf-8")}, '${sqlStr(projectName)}', 'in progress', 'codex', '${now}', '${now}')`
  );

  wikiLog(`SessionSetup: created placeholder for ${sessionId} (${cwd})`);
}

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if ((process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1") return;

  const input = await readStdin<CodexSessionStartInput>();
  const creds = loadCredentials();
  if (!creds?.token) { log("no credentials"); return; }

  // Backfill userName if missing
  if (!creds.userName) {
    try {
      const { userInfo } = await import("node:os");
      creds.userName = userInfo().username ?? "unknown";
      saveCredentials(creds);
      log(`backfilled userName: ${creds.userName}`);
    } catch { /* non-fatal */ }
  }

  // Table setup + sync — always sync, only skip placeholder when capture disabled
  const captureEnabled = (process.env.HIVEMIND_CAPTURE ?? process.env.DEEPLAKE_CAPTURE) !== "false";
  if (input.session_id) {
    try {
      const config = loadConfig();
      if (config) {
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
        await api.ensureTable();
        if (captureEnabled) {
          if (isSessionWriteDisabled(config.sessionsTableName)) {
            log(`sessions table disabled, skipping setup for "${config.sessionsTableName}"`);
          } else {
            try {
              await api.ensureSessionsTable(config.sessionsTableName);
              const drain = await drainSessionQueues(api, {
                sessionsTable: config.sessionsTableName,
              });
              if (drain.flushedSessions > 0) {
                log(`drained ${drain.flushedSessions} queued session(s), rows=${drain.rows}, batches=${drain.batches}`);
              }
            } catch (e: any) {
              if (isSessionWriteAuthError(e)) {
                markSessionWriteDisabled(config.sessionsTableName, e.message);
                log(`sessions table unavailable, skipping setup: ${e.message}`);
              } else {
                throw e;
              }
            }
          }
          await createPlaceholder(api, config.tableName, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
        }
        log("setup complete");
      }
    } catch (e: any) {
      log(`setup failed: ${e.message}`);
      wikiLog(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }

  // Version check + auto-update
  const autoupdate = creds.autoupdate !== false;
  try {
    const current = getInstalledVersion(__bundleDir, ".codex-plugin");
    if (current) {
      const latest = await getLatestVersionCached({
        url: GITHUB_RAW_PKG,
        timeoutMs: VERSION_CHECK_TIMEOUT,
      });
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log(`autoupdate: updating ${current} → ${latest}`);
          try {
            const tag = `v${latest}`;
            if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`unsafe version tag: ${tag}`);
            const findCmd = `INSTALL_DIR=""; ` +
              `CACHE_DIR=$(find ~/.codex/plugins/cache -maxdepth 3 -name "hivemind" -type d 2>/dev/null | head -1); ` +
              `if [ -n "$CACHE_DIR" ]; then INSTALL_DIR=$(ls -1d "$CACHE_DIR"/*/ 2>/dev/null | tail -1); ` +
              `elif [ -d ~/.codex/hivemind ]; then INSTALL_DIR=~/.codex/hivemind; fi; ` +
              `if [ -n "$INSTALL_DIR" ]; then ` +
              `TMPDIR=$(mktemp -d); ` +
              `git clone --depth 1 --branch ${tag} -q https://github.com/activeloopai/hivemind.git "$TMPDIR/hivemind" 2>/dev/null && ` +
              `cp -r "$TMPDIR/hivemind/codex/"* "$INSTALL_DIR/" 2>/dev/null; ` +
              `rm -rf "$TMPDIR"; fi`;
            execSync(findCmd, { stdio: "ignore", timeout: 60_000 });
            process.stderr.write(`Hivemind auto-updated: ${current} → ${latest}. Restart Codex to apply.\n`);
            log(`autoupdate succeeded: ${current} → ${latest} (tag: ${tag})`);
          } catch (e: any) {
            process.stderr.write(`Hivemind update available: ${current} → ${latest}. Auto-update failed.\n`);
            log(`autoupdate failed: ${e.message}`);
          }
        } else {
          process.stderr.write(`Hivemind update available: ${current} → ${latest}.\n`);
          log(`update available (autoupdate off): ${current} → ${latest}`);
        }
      } else {
        log(`version up to date: ${current}`);
      }
    }
  } catch (e: any) {
    log(`version check failed: ${e.message}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
