/**
 * Hermes on_session_end hook (fire-and-forget).
 *
 * Spawns a final wiki-worker run via `hermes -z` so the session gets
 * an AI summary in the memory table. Mirrors the codex/CC flow.
 */

import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { loadConfig } from "../../config.js";
import { tryAcquireLock } from "../summary-state.js";
import { bundleDirFromImportMeta, spawnHermesWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { forceSessionEndTrigger } from "../../skillify/triggers.js";

const log = (msg: string) => _log("hermes-session-end", msg);

interface HermesSessionEndInput {
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  const input = await readStdin<HermesSessionEndInput>();
  const sessionId = input.session_id ?? "";
  log(`session=${sessionId || "?"} cwd=${input.cwd ?? "?"}`);
  if (!sessionId) return;
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`SessionEnd: periodic worker already running for ${sessionId}, skipping final`);
    return;
  }
  const config = loadConfig();
  if (!config) { wikiLog(`SessionEnd: no config, skipping summary`); return; }
  const cwd = input.cwd ?? process.cwd();

  // Independent try blocks per worker — a failure in wiki spawn must not
  // suppress the skillify trigger and vice versa.
  try {
    spawnHermesWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "SessionEnd",
    });
  } catch (e: any) {
    wikiLog(`SessionEnd: wiki spawn failed: ${e?.message ?? e}`);
  }
  try {
    forceSessionEndTrigger({
      config,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      agent: "hermes",
      sessionId,
    });
  } catch (e: any) {
    wikiLog(`SessionEnd: skillify trigger failed: ${e?.message ?? e}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
