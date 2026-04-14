#!/usr/bin/env node

// dist/src/hooks/wiki-worker.js
import { readFileSync, writeFileSync, existsSync, appendFileSync as appendFileSync2, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join2 } from "node:path";

// dist/src/utils/debug.js
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DEBUG = process.env.DEEPLAKE_DEBUG === "1";
var LOG = join(homedir(), ".deeplake", "hook-debug.log");
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// dist/src/hooks/wiki-worker.js
var cfg = JSON.parse(readFileSync(process.argv[2], "utf-8"));
var tmpDir = cfg.tmpDir;
var tmpJsonl = join2(tmpDir, "session.jsonl");
var tmpSummary = join2(tmpDir, "summary.md");
function wlog(msg) {
  try {
    mkdirSync(cfg.hooksDir, { recursive: true });
    appendFileSync2(cfg.wikiLog, `[${utcTimestamp()}] wiki-worker(${cfg.sessionId}): ${msg}
`);
  } catch {
  }
}
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
async function query(sql, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`${cfg.apiUrl}/workspaces/${cfg.workspaceId}/tables/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "X-Activeloop-Org-Id": cfg.orgId
      },
      body: JSON.stringify({ query: sql })
    });
    if (r.ok) {
      const j = await r.json();
      if (!j.columns || !j.rows)
        return [];
      return j.rows.map((row) => Object.fromEntries(j.columns.map((col, i) => [col, row[i]])));
    }
    if (attempt < retries && (r.status === 502 || r.status === 503 || r.status === 429)) {
      wlog(`API ${r.status}, retrying in ${attempt + 1}s...`);
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1e3));
      continue;
    }
    throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}
function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
  }
}
async function main() {
  try {
    wlog("fetching session events");
    await query(`SELECT deeplake_sync_table('${cfg.sessionsTable}')`);
    const rows = await query(`SELECT message, creation_date FROM "${cfg.sessionsTable}" WHERE path LIKE '${esc(`/sessions/%${cfg.sessionId}%`)}' ORDER BY creation_date ASC`);
    if (rows.length === 0) {
      wlog("no session events found \u2014 exiting");
      return;
    }
    const jsonlContent = rows.map((r) => typeof r.message === "string" ? r.message : JSON.stringify(r.message)).join("\n");
    const jsonlLines = rows.length;
    const pathRows = await query(`SELECT DISTINCT path FROM "${cfg.sessionsTable}" WHERE path LIKE '${esc(`/sessions/%${cfg.sessionId}%`)}' LIMIT 1`);
    const jsonlServerPath = pathRows.length > 0 ? pathRows[0].path : `/sessions/unknown/${cfg.sessionId}.jsonl`;
    writeFileSync(tmpJsonl, jsonlContent);
    wlog(`found ${jsonlLines} events at ${jsonlServerPath}`);
    let prevOffset = 0;
    try {
      await query(`SELECT deeplake_sync_table('${cfg.memoryTable}')`);
      const sumRows = await query(`SELECT summary FROM "${cfg.memoryTable}" WHERE path = '${esc(`/summaries/${cfg.userName}/${cfg.sessionId}.md`)}' LIMIT 1`);
      if (sumRows.length > 0 && sumRows[0]["summary"]) {
        const existing = sumRows[0]["summary"];
        const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
        if (match)
          prevOffset = parseInt(match[1], 10);
        writeFileSync(tmpSummary, existing);
        wlog(`existing summary found, offset=${prevOffset}`);
      }
    } catch {
    }
    const prompt = cfg.promptTemplate.replace(/__JSONL__/g, tmpJsonl).replace(/__SUMMARY__/g, tmpSummary).replace(/__SESSION_ID__/g, cfg.sessionId).replace(/__PROJECT__/g, cfg.project).replace(/__PREV_OFFSET__/g, String(prevOffset)).replace(/__JSONL_LINES__/g, String(jsonlLines)).replace(/__JSONL_SERVER_PATH__/g, jsonlServerPath);
    wlog("running claude -p");
    try {
      execFileSync(cfg.claudeBin, [
        "-p",
        prompt,
        "--no-session-persistence",
        "--model",
        "haiku",
        "--permission-mode",
        "bypassPermissions"
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 12e4,
        env: { ...process.env, DEEPLAKE_WIKI_WORKER: "1", DEEPLAKE_CAPTURE: "false" }
      });
      wlog("claude -p exited (code 0)");
    } catch (e) {
      wlog(`claude -p failed: ${e.status ?? e.message}`);
    }
    if (existsSync(tmpSummary)) {
      const text = readFileSync(tmpSummary, "utf-8");
      if (text.trim()) {
        const fname = `${cfg.sessionId}.md`;
        const vpath = `/summaries/${cfg.userName}/${fname}`;
        const ts = (/* @__PURE__ */ new Date()).toISOString();
        await query(`SELECT deeplake_sync_table('${cfg.memoryTable}')`);
        const existing = await query(`SELECT path FROM "${cfg.memoryTable}" WHERE path = '${esc(vpath)}' LIMIT 1`);
        if (existing.length > 0) {
          await query(`UPDATE "${cfg.memoryTable}" SET summary = E'${esc(text)}', size_bytes = ${Buffer.byteLength(text)}, last_update_date = '${ts}' WHERE path = '${esc(vpath)}'`);
        } else {
          const id = crypto.randomUUID();
          await query(`INSERT INTO "${cfg.memoryTable}" (id, path, filename, summary, author, mime_type, size_bytes, project, agent, creation_date, last_update_date) VALUES ('${id}', '${esc(vpath)}', '${esc(fname)}', E'${esc(text)}', '${esc(cfg.userName)}', 'text/markdown', ${Buffer.byteLength(text)}, '${esc(cfg.project)}', 'claude_code', '${ts}', '${ts}')`);
        }
        wlog(`uploaded ${vpath}`);
        try {
          const whatHappened = text.match(/## What Happened\n([\s\S]*?)(?=\n##|$)/);
          const desc = whatHappened ? whatHappened[1].trim().slice(0, 300) : "completed";
          await query(`UPDATE "${cfg.memoryTable}" SET description = E'${esc(desc)}', last_update_date = '${ts}' WHERE path = '${esc(vpath)}'`);
          wlog("updated description");
        } catch (e) {
          wlog(`description update failed: ${e.message}`);
        }
      }
    } else {
      wlog("no summary file generated");
    }
    wlog("done");
  } catch (e) {
    wlog(`fatal: ${e.message}`);
  } finally {
    cleanup();
  }
}
main();
