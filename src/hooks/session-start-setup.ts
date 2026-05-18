#!/usr/bin/env node

/**
 * SessionStart async setup hook:
 * Runs server-side operations (table creation, placeholder, version check)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadCredentials, saveCredentials } from "../commands/auth.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled, embeddingsStatus } from "../embeddings/disable.js";
import { autoUpdate } from "./shared/autoupdate.js";
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

  // Centralized autoupdate fires BEFORE the DB ensure-table calls — those
  // can stall for tens of seconds against a slow/unreachable backend, and
  // autoUpdate has zero dependency on table state. The 4h cache means this
  // is a near-instant no-op when session-start.ts already fired the
  // helper microseconds earlier.
  await autoUpdate(creds, { agent: "claude" });

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
      ? "@huggingface/transformers not installed (run `hivemind embeddings install` to enable)"
      : "embeddings disabled in ~/.deeplake/config.json (run `hivemind embeddings enable` to opt in)";
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
