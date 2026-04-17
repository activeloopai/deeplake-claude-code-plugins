#!/usr/bin/env node

/**
 * SessionStart async setup hook:
 * Runs server-side operations (table creation, placeholder, version check)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log, utcTimestamp } from "../utils/debug.js";
const log = (msg: string) => _log("session-setup", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));

const GITHUB_RAW_PKG = "https://raw.githubusercontent.com/activeloopai/hivemind/main/package.json";
const VERSION_CHECK_TIMEOUT = 3000;

const HOME = homedir();
const WIKI_LOG = join(HOME, ".claude", "hooks", "deeplake-wiki.log");

function wikiLog(msg: string): void {
  try {
    mkdirSync(join(HOME, ".claude", "hooks"), { recursive: true });
    appendFileSync(WIKI_LOG, `[${utcTimestamp()}] ${msg}\n`);
  } catch { /* ignore */ }
}

function getInstalledVersion(): string | null {
  try {
    const pluginJson = join(__bundleDir, "..", ".claude-plugin", "plugin.json");
    const plugin = JSON.parse(readFileSync(pluginJson, "utf-8"));
    if (plugin.version) return plugin.version;
  } catch { /* fall through */ }
  let dir = __bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if ((pkg.name === "hivemind" || pkg.name === "hivemind-codex") && pkg.version) return pkg.version;
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  if ((process.env.HIVEMIND_WIKI_WORKER ?? process.env.DEEPLAKE_WIKI_WORKER) === "1") return;

  const input = await readStdin<SessionStartInput>();
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

  if (input.session_id) {
    try {
      const config = loadConfig();
      if (config) {
        const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
        await api.ensureTable();
        await api.ensureSessionsTable(config.sessionsTableName);
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
    const current = getInstalledVersion();
    if (current) {
      const latest = await getLatestVersion();
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log(`autoupdate: updating ${current} → ${latest}`);
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes
              .map(s => `claude plugin update hivemind@hivemind --scope ${s} 2>/dev/null`)
              .join("; ");
            execSync(cmd, { stdio: "ignore", timeout: 60_000 });
            process.stderr.write(`✅ Hivemind auto-updated: ${current} → ${latest}. Run /reload-plugins to apply.\n`);
            log(`autoupdate succeeded: ${current} → ${latest}`);
          } catch (e: any) {
            process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Auto-update failed — run /hivemind:update to upgrade manually.\n`);
            log(`autoupdate failed: ${e.message}`);
          }
        } else {
          process.stderr.write(`⬆️ Hivemind update available: ${current} → ${latest}. Run /hivemind:update to upgrade.\n`);
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
