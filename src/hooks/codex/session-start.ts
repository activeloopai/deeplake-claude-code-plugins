#!/usr/bin/env node

/**
 * Codex SessionStart hook:
 * 1. If no credentials → log warning
 * 2. Inject Deeplake memory instructions into Codex's context via additionalContext
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model, source }
 * Codex output: { additionalContext: "..." } or plain text on stdout
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../../commands/auth.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
const log = (msg: string) => _log("codex-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = join(__bundleDir, "commands", "auth-login.js");

// Codex-specific context: references Codex commands instead of Claude Code slash commands.
// Uses Bash tool for search since Codex doesn't have a standalone Grep tool.
const context = `DEEPLAKE MEMORY: Persistent memory at ~/.deeplake/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: grep -r "keyword" ~/.deeplake/memory/
Do NOT spawn subagents to read deeplake memory.`;

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
const VERSION_CHECK_TIMEOUT = 3000;

function getInstalledVersion(): string | null {
  try {
    // Read version from the plugin's own manifest (not the root package.json)
    const pluginJson = join(__bundleDir, "..", ".codex-plugin", "plugin.json");
    const plugin = JSON.parse(readFileSync(pluginJson, "utf-8"));
    if (plugin.version) return plugin.version;
  } catch { /* fall through */ }
  try {
    // Fallback: package.json (works for non-monorepo installs)
    const pkgPath = join(__bundleDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_RAW_PKG, { signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT) });
    if (!res.ok) return null;
    const pkg = await res.json();
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

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

  await api.query(`SELECT deeplake_sync_table('${table}')`);
  const existing = await api.query(
    `SELECT path FROM "${table}" WHERE path = '${sqlStr(summaryPath)}' LIMIT 1`
  );
  if (existing.length > 0) {
    wikiLog(`SessionStart: summary exists for ${sessionId} (resumed)`);
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

  wikiLog(`SessionStart: created placeholder for ${sessionId} (${cwd})`);
}

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string; // "startup" | "resume"
}

async function main(): Promise<void> {
  if (process.env.DEEPLAKE_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  let creds = loadCredentials();

  if (!creds?.token) {
    log("no credentials found — run auth login to authenticate");
  } else {
    log(`credentials loaded: org=${creds.orgName ?? creds.orgId}`);
    if (creds.token && !creds.userName) {
      try {
        const { userInfo } = await import("node:os");
        creds.userName = userInfo().username ?? "unknown";
        saveCredentials(creds);
        log(`backfilled userName: ${creds.userName}`);
      } catch { /* non-fatal */ }
    }
  }

  // Create placeholder summary
  if (input.session_id && creds?.token) {
    try {
      const config = loadConfig();
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);
        await api.ensureTable();
        await api.ensureSessionsTable(sessionsTable);
        await createPlaceholder(api, table, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
        log("placeholder created");
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
      wikiLog(`SessionStart: placeholder failed for ${input.session_id}: ${e.message}`);
    }
  }

  // Version check + auto-update (via GitHub clone into cache directory)
  const autoupdate = creds?.autoupdate !== false; // default: true
  let updateNotice = "";
  try {
    const current = getInstalledVersion();
    if (current) {
      const latest = await getLatestVersion();
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log(`autoupdate: updating ${current} → ${latest}`);
          try {
            // Find the plugin cache directory and update from GitHub
            const findCmd = `PLUGIN_DIR=$(find ~/.codex/plugins/cache -maxdepth 3 -name "hivemind" -type d 2>/dev/null | head -1); ` +
              `if [ -n "$PLUGIN_DIR" ]; then ` +
              `VERSION_DIR=$(ls -1d "$PLUGIN_DIR"/*/ 2>/dev/null | tail -1); ` +
              `TMPDIR=$(mktemp -d); ` +
              `git clone --depth 1 -q https://github.com/activeloopai/hivemind.git "$TMPDIR/hivemind" 2>/dev/null && ` +
              `cp -r "$TMPDIR/hivemind/codex/"* "$VERSION_DIR/" 2>/dev/null; ` +
              `rm -rf "$TMPDIR"; fi`;
            execSync(findCmd, { stdio: "ignore", timeout: 60_000 });
            updateNotice = `\n\nHivemind auto-updated: ${current} → ${latest}. Restart Codex to apply.`;
            process.stderr.write(`Hivemind auto-updated: ${current} → ${latest}. Restart Codex to apply.\n`);
            log(`autoupdate succeeded: ${current} → ${latest}`);
          } catch (e: any) {
            updateNotice = `\n\nHivemind update available: ${current} → ${latest}. Auto-update failed.`;
            process.stderr.write(`Hivemind update available: ${current} → ${latest}. Auto-update failed.\n`);
            log(`autoupdate failed: ${e.message}`);
          }
        } else {
          updateNotice = `\n\nHivemind update available: ${current} → ${latest}.`;
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

  const additionalContext = creds?.token
    ? `${context}\nLogged in to Deeplake as org: ${creds.orgName ?? creds.orgId} (workspace: ${creds.workspaceId ?? "default"})${updateNotice}`
    : `${context}\nNot logged in to Deeplake. Run: node "${AUTH_CMD}" login${updateNotice}`;

  // Codex SessionStart: plain text on stdout is added as developer context.
  // JSON { additionalContext } format is rejected by Codex 0.118.0.
  console.log(additionalContext);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
