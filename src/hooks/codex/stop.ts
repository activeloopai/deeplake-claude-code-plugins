#!/usr/bin/env node

/**
 * Codex Stop hook — handles both capture and session-end (wiki summary spawn).
 *
 * Codex has no SessionEnd event, so this hook does double duty:
 * 1. Captures the stop event to the sessions table (like capture.ts)
 * 2. Spawns the wiki worker to generate the session summary (like session-end.ts)
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model }
 * Codex output: JSON with optional { decision: "block", reason: "..." } to continue
 */

import { readFileSync, existsSync } from "node:fs";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr } from "../../utils/sql.js";
import { log as _log } from "../../utils/debug.js";
import { bundleDirFromImportMeta, spawnCodexWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { tryAcquireLock, releaseLock } from "../summary-state.js";
import { buildSessionPath } from "../../utils/session-path.js";

const log = (msg: string) => _log("codex-stop", msg);

interface CodexStopInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
}

const CAPTURE = process.env.HIVEMIND_CAPTURE !== "false";

async function main(): Promise<void> {
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexStopInput>();
  const sessionId = input.session_id;
  if (!sessionId) return;

  const config = loadConfig();
  if (!config) { log("no config"); return; }

  // 1. Capture the stop event (try to extract last assistant message from transcript)
  if (CAPTURE) {
    try {
      const sessionsTable = config.sessionsTableName;
      const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, sessionsTable);
      const ts = new Date().toISOString();

      // Codex Stop doesn't include last_assistant_message, but it provides
      // transcript_path. Try to extract the last assistant message from it.
      let lastAssistantMessage = "";
      if (input.transcript_path) {
        try {
          const transcriptPath = input.transcript_path;
          if (existsSync(transcriptPath)) {
            const transcript = readFileSync(transcriptPath, "utf-8");
            // Codex transcript is JSONL with format:
            // {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
            const lines = transcript.trim().split("\n").reverse();
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                // Codex nests the message inside payload
                const msg = entry.payload ?? entry;
                if (msg.role === "assistant" && msg.content) {
                  const content = typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content.filter((b: any) => b.type === "output_text" || b.type === "text").map((b: any) => b.text).join("\n")
                      : "";
                  if (content) {
                    lastAssistantMessage = content.slice(0, 4000);
                    break;
                  }
                }
              } catch { /* skip malformed line */ }
            }
            if (lastAssistantMessage) log(`extracted assistant message from transcript (${lastAssistantMessage.length} chars)`);
          }
        } catch (e: any) {
          log(`transcript read failed: ${e.message}`);
        }
      }

      const entry = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        model: input.model,
        timestamp: ts,
        type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
        content: lastAssistantMessage,
      };
      const line = JSON.stringify(entry);
      const sessionPath = buildSessionPath(config, sessionId);
      const projectName = (input.cwd ?? "").split("/").pop() || "unknown";
      const filename = sessionPath.split("/").pop() ?? "";
      const jsonForSql = sqlStr(line);

      const insertSql =
        `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
        `VALUES ('${crypto.randomUUID()}', '${sqlStr(sessionPath)}', '${sqlStr(filename)}', '${jsonForSql}'::jsonb, '${sqlStr(config.userName)}', ` +
        `${Buffer.byteLength(line, "utf-8")}, '${sqlStr(projectName)}', 'Stop', 'codex', '${ts}', '${ts}')`;

      await api.query(insertSql);
      log("stop event captured");
    } catch (e: any) {
      log(`capture failed: ${e.message}`);
    }
  }

  // 2. Spawn wiki worker — skip when capture disabled
  if (!CAPTURE) return;

  // Coordinate with the periodic worker: if one is already running for this
  // session, skip. Two workers writing the same summary row trip the
  // Deeplake UPDATE-coalescing quirk (see CLAUDE.md) and drop one write.
  if (!tryAcquireLock(sessionId)) {
    wikiLog(`Stop: periodic worker already running for ${sessionId}, skipping`);
    return;
  }

  wikiLog(`Stop: triggering summary for ${sessionId}`);
  try {
    spawnCodexWikiWorker({
      config,
      sessionId,
      cwd: input.cwd ?? "",
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Stop",
    });
  } catch (e: any) {
    // Spawn threw before the worker took ownership of the lock: release
    // it here so a --resume can retrigger periodic summaries without
    // waiting for the 10-minute stale reclaim.
    log(`spawn failed: ${e.message}`);
    try {
      releaseLock(sessionId);
    } catch (releaseErr: any) {
      log(`releaseLock after spawn failure also failed: ${releaseErr.message}`);
    }
    throw e;
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
