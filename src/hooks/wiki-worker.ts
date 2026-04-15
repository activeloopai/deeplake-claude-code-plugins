#!/usr/bin/env node

/**
 * Background wiki worker — reads session events from the sessions table,
 * runs claude -p to generate a wiki summary, and uploads it to the memory table.
 *
 * Invoked by session-end.ts as: node wiki-worker.js <config.json>
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { utcTimestamp } from "../utils/debug.js";

interface WorkerConfig {
  apiUrl: string;
  token: string;
  orgId: string;
  workspaceId: string;
  memoryTable: string;
  sessionsTable: string;
  sessionId: string;
  userName: string;
  project: string;
  tmpDir: string;
  claudeBin: string;
  wikiLog: string;
  hooksDir: string;
  promptTemplate: string;
}

const cfg: WorkerConfig = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const tmpDir = cfg.tmpDir;
const tmpJsonl = join(tmpDir, "session.jsonl");
const tmpSummary = join(tmpDir, "summary.md");

function wlog(msg: string): void {
  try {
    mkdirSync(cfg.hooksDir, { recursive: true });
    appendFileSync(cfg.wikiLog, `[${utcTimestamp()}] wiki-worker(${cfg.sessionId}): ${msg}\n`);
  } catch { /* ignore */ }
}

/** Escape a string for use inside a SQL single-quoted literal. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

async function query(sql: string, retries = 2): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`${cfg.apiUrl}/workspaces/${cfg.workspaceId}/tables/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "X-Activeloop-Org-Id": cfg.orgId,
      },
      body: JSON.stringify({ query: sql }),
    });
    if (r.ok) {
      const j = await r.json() as { columns?: string[]; rows?: unknown[][] };
      if (!j.columns || !j.rows) return [];
      return j.rows.map(row =>
        Object.fromEntries(j.columns!.map((col, i) => [col, row[i]]))
      );
    }
    if (attempt < retries && (r.status === 502 || r.status === 503 || r.status === 429)) {
      wlog(`API ${r.status}, retrying in ${attempt + 1}s...`);
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      continue;
    }
    throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}

function cleanup(): void {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  try {
    // 1. Fetch session events from sessions table, reconstruct JSONL
    wlog("fetching session events");
    const rows = await query(
      `SELECT message, creation_date FROM "${cfg.sessionsTable}" ` +
      `WHERE path LIKE '${esc(`/sessions/%${cfg.sessionId}%`)}' ORDER BY creation_date ASC`
    );

    if (rows.length === 0) {
      wlog("no session events found — exiting");
      return;
    }

    // Reconstruct JSONL from individual rows (message is JSONB — may be object or string)
    const jsonlContent = rows
      .map(r => typeof r.message === "string" ? r.message : JSON.stringify(r.message))
      .join("\n");
    const jsonlLines = rows.length;

    // Derive the server path
    const pathRows = await query(
      `SELECT DISTINCT path FROM "${cfg.sessionsTable}" ` +
      `WHERE path LIKE '${esc(`/sessions/%${cfg.sessionId}%`)}' LIMIT 1`
    );
    const jsonlServerPath = pathRows.length > 0
      ? pathRows[0].path as string
      : `/sessions/unknown/${cfg.sessionId}.jsonl`;

    writeFileSync(tmpJsonl, jsonlContent);
    wlog(`found ${jsonlLines} events at ${jsonlServerPath}`);

    // 2. Check for existing summary in memory table (resumed session)
    let prevOffset = 0;
    try {
      const sumRows = await query(
        `SELECT summary FROM "${cfg.memoryTable}" ` +
        `WHERE path = '${esc(`/summaries/${cfg.userName}/${cfg.sessionId}.md`)}' LIMIT 1`
      );
      if (sumRows.length > 0 && sumRows[0]["summary"]) {
        const existing = sumRows[0]["summary"] as string;
        const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
        if (match) prevOffset = parseInt(match[1], 10);
        writeFileSync(tmpSummary, existing);
        wlog(`existing summary found, offset=${prevOffset}`);
      }
    } catch { /* no existing summary */ }

    // 3. Build prompt and run claude -p
    const prompt = cfg.promptTemplate
      .replace(/__JSONL__/g, tmpJsonl)
      .replace(/__SUMMARY__/g, tmpSummary)
      .replace(/__SESSION_ID__/g, cfg.sessionId)
      .replace(/__PROJECT__/g, cfg.project)
      .replace(/__PREV_OFFSET__/g, String(prevOffset))
      .replace(/__JSONL_LINES__/g, String(jsonlLines))
      .replace(/__JSONL_SERVER_PATH__/g, jsonlServerPath);

    wlog("running claude -p");
    try {
      execFileSync(cfg.claudeBin, [
        "-p", prompt,
        "--no-session-persistence",
        "--model", "haiku",
        "--permission-mode", "bypassPermissions",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, DEEPLAKE_WIKI_WORKER: "1", DEEPLAKE_CAPTURE: "false" },
      });
      wlog("claude -p exited (code 0)");
    } catch (e: any) {
      wlog(`claude -p failed: ${e.status ?? e.message}`);
    }

    // 4. Upload summary to memory table
    if (existsSync(tmpSummary)) {
      const text = readFileSync(tmpSummary, "utf-8");
      if (text.trim()) {
        const fname = `${cfg.sessionId}.md`;
        const vpath = `/summaries/${cfg.userName}/${fname}`;
        const ts = new Date().toISOString();

          const existing = await query(
          `SELECT path FROM "${cfg.memoryTable}" WHERE path = '${esc(vpath)}' LIMIT 1`
        );

        if (existing.length > 0) {
          await query(
            `UPDATE "${cfg.memoryTable}" SET ` +
            `summary = E'${esc(text)}', ` +
            `size_bytes = ${Buffer.byteLength(text)}, last_update_date = '${ts}' ` +
            `WHERE path = '${esc(vpath)}'`
          );
        } else {
          const id = crypto.randomUUID();
          await query(
            `INSERT INTO "${cfg.memoryTable}" (id, path, filename, summary, author, mime_type, size_bytes, project, agent, creation_date, last_update_date) ` +
            `VALUES ('${id}', '${esc(vpath)}', '${esc(fname)}', E'${esc(text)}', '${esc(cfg.userName)}', 'text/markdown', ` +
            `${Buffer.byteLength(text)}, '${esc(cfg.project)}', 'claude_code', '${ts}', '${ts}')`
          );
        }
        wlog(`uploaded ${vpath}`);

        // Update description from "What Happened" section
        try {
          const whatHappened = text.match(/## What Happened\n([\s\S]*?)(?=\n##|$)/);
          const desc = whatHappened ? whatHappened[1].trim().slice(0, 300) : "completed";
          await query(
            `UPDATE "${cfg.memoryTable}" SET description = E'${esc(desc)}', ` +
            `last_update_date = '${ts}' WHERE path = '${esc(vpath)}'`
          );
          wlog("updated description");
        } catch (e: any) {
          wlog(`description update failed: ${e.message}`);
        }
      }
    } else {
      wlog("no summary file generated");
    }

    wlog("done");
  } catch (e: any) {
    wlog(`fatal: ${e.message}`);
  } finally {
    cleanup();
  }
}

main();
