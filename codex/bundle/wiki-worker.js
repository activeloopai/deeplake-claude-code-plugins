#!/usr/bin/env node

// dist/src/hooks/codex/wiki-worker.js
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync2, appendFileSync, mkdirSync as mkdirSync2, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join2 } from "node:path";

// dist/src/hooks/summary-state.js
import { readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var STATE_DIR = join(homedir(), ".claude", "hooks", "summary-state");
var YIELD_BUF = new Int32Array(new SharedArrayBuffer(4));
function statePath(sessionId) {
  return join(STATE_DIR, `${sessionId}.json`);
}
function lockPath(sessionId) {
  return join(STATE_DIR, `${sessionId}.lock`);
}
function readState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync(p))
    return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function withRmwLock(sessionId, fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  const rmwLock = statePath(sessionId) + ".rmw";
  const deadline = Date.now() + 2e3;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(rmwLock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() > deadline) {
        try {
          unlinkSync(rmwLock);
        } catch {
        }
        continue;
      }
      Atomics.wait(YIELD_BUF, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(rmwLock);
    } catch {
    }
  }
}
function finalizeSummary(sessionId, jsonlLines) {
  withRmwLock(sessionId, () => {
    const prev = readState(sessionId);
    writeState(sessionId, {
      lastSummaryAt: Date.now(),
      lastSummaryCount: jsonlLines,
      totalCount: Math.max(prev?.totalCount ?? 0, jsonlLines)
    });
  });
}
function releaseLock(sessionId) {
  try {
    unlinkSync(lockPath(sessionId));
  } catch {
  }
}

// dist/src/hooks/upload-summary.js
import { randomUUID } from "node:crypto";
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function extractDescription(text) {
  const match = text.match(/## What Happened\n([\s\S]*?)(?=\n##|$)/);
  return match ? match[1].trim().slice(0, 300) : "completed";
}
async function uploadSummary(query2, params) {
  const { tableName, vpath, fname, userName, project, agent, text } = params;
  const ts = params.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const desc = extractDescription(text);
  const sizeBytes = Buffer.byteLength(text);
  const existing = await query2(`SELECT path FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`);
  if (existing.length > 0) {
    const sql2 = `UPDATE "${tableName}" SET summary = E'${esc(text)}', size_bytes = ${sizeBytes}, description = E'${esc(desc)}', last_update_date = '${ts}' WHERE path = '${esc(vpath)}'`;
    await query2(sql2);
    return { path: "update", sql: sql2, descLength: desc.length, summaryLength: text.length };
  }
  const sql = `INSERT INTO "${tableName}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ('${randomUUID()}', '${esc(vpath)}', '${esc(fname)}', E'${esc(text)}', '${esc(userName)}', 'text/markdown', ${sizeBytes}, '${esc(project)}', E'${esc(desc)}', '${esc(agent)}', '${ts}', '${ts}')`;
  await query2(sql);
  return { path: "insert", sql, descLength: desc.length, summaryLength: text.length };
}

// dist/src/hooks/codex/wiki-worker.js
var cfg = JSON.parse(readFileSync2(process.argv[2], "utf-8"));
var tmpDir = cfg.tmpDir;
var tmpJsonl = join2(tmpDir, "session.jsonl");
var tmpSummary = join2(tmpDir, "summary.md");
function wlog(msg) {
  try {
    mkdirSync2(cfg.hooksDir, { recursive: true });
    appendFileSync(cfg.wikiLog, `[${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)}] wiki-worker(${cfg.sessionId}): ${msg}
`);
  } catch {
  }
}
function esc2(s) {
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
    const rows = await query(`SELECT message, creation_date FROM "${cfg.sessionsTable}" WHERE path LIKE E'${esc2(`/sessions/%${cfg.sessionId}%`)}' ORDER BY creation_date ASC`);
    if (rows.length === 0) {
      wlog("no session events found \u2014 exiting");
      return;
    }
    const jsonlContent = rows.map((r) => typeof r.message === "string" ? r.message : JSON.stringify(r.message)).join("\n");
    const jsonlLines = rows.length;
    const pathRows = await query(`SELECT DISTINCT path FROM "${cfg.sessionsTable}" WHERE path LIKE '${esc2(`/sessions/%${cfg.sessionId}%`)}' LIMIT 1`);
    const jsonlServerPath = pathRows.length > 0 ? pathRows[0].path : `/sessions/unknown/${cfg.sessionId}.jsonl`;
    writeFileSync2(tmpJsonl, jsonlContent);
    wlog(`found ${jsonlLines} events at ${jsonlServerPath}`);
    let prevOffset = 0;
    try {
      const sumRows = await query(`SELECT summary FROM "${cfg.memoryTable}" WHERE path = '${esc2(`/summaries/${cfg.userName}/${cfg.sessionId}.md`)}' LIMIT 1`);
      if (sumRows.length > 0 && sumRows[0]["summary"]) {
        const existing = sumRows[0]["summary"];
        const match = existing.match(/\*\*JSONL offset\*\*:\s*(\d+)/);
        if (match)
          prevOffset = parseInt(match[1], 10);
        writeFileSync2(tmpSummary, existing);
        wlog(`existing summary found, offset=${prevOffset}`);
      }
    } catch {
    }
    const prompt = cfg.promptTemplate.replace(/__JSONL__/g, tmpJsonl).replace(/__SUMMARY__/g, tmpSummary).replace(/__SESSION_ID__/g, cfg.sessionId).replace(/__PROJECT__/g, cfg.project).replace(/__PREV_OFFSET__/g, String(prevOffset)).replace(/__JSONL_LINES__/g, String(jsonlLines)).replace(/__JSONL_SERVER_PATH__/g, jsonlServerPath);
    wlog("running codex exec");
    try {
      execFileSync(cfg.codexBin, [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 12e4,
        env: { ...process.env, DEEPLAKE_WIKI_WORKER: "1", DEEPLAKE_CAPTURE: "false" }
      });
      wlog("codex exec exited (code 0)");
    } catch (e) {
      wlog(`codex exec failed: ${e.status ?? e.message}`);
    }
    if (existsSync2(tmpSummary)) {
      const text = readFileSync2(tmpSummary, "utf-8");
      if (text.trim()) {
        const fname = `${cfg.sessionId}.md`;
        const vpath = `/summaries/${cfg.userName}/${fname}`;
        const result = await uploadSummary(query, {
          tableName: cfg.memoryTable,
          vpath,
          fname,
          userName: cfg.userName,
          project: cfg.project,
          agent: "codex",
          sessionId: cfg.sessionId,
          text
        });
        wlog(`uploaded ${vpath} (summary=${result.summaryLength}, desc=${result.descLength})`);
        try {
          finalizeSummary(cfg.sessionId, jsonlLines);
          wlog(`sidecar updated: lastSummaryCount=${jsonlLines}`);
        } catch (e) {
          wlog(`sidecar update failed: ${e.message}`);
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
    try {
      releaseLock(cfg.sessionId);
    } catch {
    }
  }
}
main();
