#!/usr/bin/env node

/**
 * SessionStart async setup hook:
 * Runs server-side operations (table creation, placeholder, version check)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { getInstalledVersion, getLatestVersion, isNewer } from "../utils/version-check.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { resolveVersionedPluginDir, snapshotPluginDir, restoreOrCleanup } from "../utils/plugin-cache.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled, embeddingsStatus } from "../embeddings/disable.js";
const log = (msg: string) => _log("session-setup", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const { log: wikiLog } = makeWikiLogger(join(homedir(), ".claude", "hooks"));

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

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
    const current = getInstalledVersion(__bundleDir, ".claude-plugin");
    if (current) {
      const latest = await getLatestVersion();
      if (latest && isNewer(latest, current)) {
        if (autoupdate) {
          log(`autoupdate: updating ${current} → ${latest}`);
          // Claude's installer deletes the old version directory, which
          // invalidates the bundle paths baked into the *current* session's
          // hook registry. Snapshot the dir first, restore it if the
          // installer wiped it — so already-loaded hooks keep working
          // until the session exits. Only applies to a real versioned
          // install layout; a local --plugin-dir dev run is skipped.
          const resolved = resolveVersionedPluginDir(__bundleDir);
          const handle = resolved ? snapshotPluginDir(resolved.pluginDir) : null;
          try {
            const scopes = ["user", "project", "local", "managed"];
            const cmd = scopes
              .map(s => `claude plugin update hivemind@hivemind --scope ${s} 2>/dev/null || true`)
              .join("; ");
            execSync(cmd, { stdio: "ignore", timeout: 60_000 });
            const outcome = restoreOrCleanup(handle);
            log(`autoupdate snapshot outcome: ${outcome}`);
            process.stderr.write(`✅ Hivemind auto-updated: ${current} → ${latest}. Run /reload-plugins to apply.\n`);
            log(`autoupdate succeeded: ${current} → ${latest}`);
          } catch (e: any) {
            restoreOrCleanup(handle);
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

  // Warm up the embedding daemon so the nomic-embed-text-v1.5 model is
  // cached and loaded before the first Grep call. The daemon eagerly
  // calls `embedder.load()` on startup (fire-and-forget), which downloads
  // the model to ~/.cache/huggingface/hub/ on first run (~130 MB q8 /
  // ~500 MB fp32) and keeps it resident for the lifetime of the process.
  // `warmup()` itself just ensures the socket is accepting connections;
  // the actual model download runs in the daemon's background — so this
  // hook stays quick even on a cold install. Opt-out via
  // HIVEMIND_EMBED_WARMUP=false for sessions that will never touch the
  // memory path (lightweight CC runs, no-network CI).
  if (embeddingsDisabled()) {
    const status = embeddingsStatus();
    const reason = status === "no-transformers"
      ? "@huggingface/transformers not installed (see README to enable embeddings)"
      : "HIVEMIND_EMBEDDINGS=false";
    log(`embed daemon warmup skipped: ${reason}`);
  } else if (process.env.HIVEMIND_EMBED_WARMUP !== "false") {
    try {
      const daemonEntry = join(__bundleDir, "embeddings", "embed-daemon.js");
      const client = new EmbedClient({ daemonEntry, timeoutMs: 300, spawnWaitMs: 5000 });
      const ok = await client.warmup();
      log(`embed daemon warmup: ${ok ? "ok" : "failed"}`);
    } catch (e: any) {
      log(`embed daemon warmup threw: ${e.message}`);
    }
  } else {
    log("embed daemon warmup skipped via HIVEMIND_EMBED_WARMUP=false");
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
