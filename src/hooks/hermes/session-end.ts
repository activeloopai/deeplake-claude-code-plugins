/**
 * Hermes on_session_end hook (fire-and-forget).
 *
 * Stub for now. Future: spawn the wiki-worker to summarize the session.
 */

import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
const log = (msg: string) => _log("hermes-session-end", msg);

interface HermesSessionEndInput {
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  const input = await readStdin<HermesSessionEndInput>();
  log(`session=${input.session_id ?? "?"} cwd=${input.cwd ?? "?"}`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
