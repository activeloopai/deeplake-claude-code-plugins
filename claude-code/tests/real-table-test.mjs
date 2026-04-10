#!/usr/bin/env node
/**
 * Manual test script: exercises INSERT/UPDATE/appendFile patterns against a real Deeplake table.
 * Uses a temporary test table, cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { homedir } from "node:os";
import { join } from "node:path";
const creds = JSON.parse(readFileSync(join(homedir(), ".deeplake/credentials.json"), "utf-8"));
const TABLE = "test_upsert_" + Date.now();
const API = creds.apiUrl + "/workspaces/" + creds.workspaceId + "/tables";

async function query(sql) {
  const r = await fetch(API + "/query", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + creds.token,
      "Content-Type": "application/json",
      "X-Activeloop-Org-Id": creds.orgId,
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`API ${r.status}: ${text.slice(0, 300)}`);
  try {
    const json = JSON.parse(text);
    // Convert columnar format {columns, rows} to array of objects
    if (json.columns && json.rows) {
      return json.rows.map(row => {
        const obj = {};
        json.columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
      });
    }
    return json.data || [];
  } catch { return []; }
}

function esc(s) { return s.replace(/\\/g, "\\\\").replace(/'/g, "''"); }
async function sync() { await query(`SELECT deeplake_sync_table('${TABLE}')`); }

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

try {
  // ── Setup ──────────────────────────────────────────────────────────────────
  console.log(`\nCreating table "${TABLE}"...`);
  await query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" (` +
    `id TEXT NOT NULL DEFAULT '', ` +
    `path TEXT NOT NULL DEFAULT '', ` +
    `filename TEXT NOT NULL DEFAULT '', ` +
    `content BYTEA NOT NULL DEFAULT ''::bytea, ` +
    `summary TEXT NOT NULL DEFAULT '', ` +
    `mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', ` +
    `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
    `timestamp TEXT NOT NULL DEFAULT ''` +
    `) USING deeplake`
  );
  console.log("Table created.\n");

  // ── Test 1: INSERT new row ─────────────────────────────────────────────────
  console.log("Test 1: INSERT new row");
  const id1 = randomUUID();
  const ts1 = new Date().toISOString();
  const text1 = "hello world";
  const hex1 = Buffer.from(text1).toString("hex");
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, content, summary, mime_type, size_bytes, timestamp) ` +
    `VALUES ('${id1}', '/test/file1.txt', 'file1.txt', E'\\\\x${hex1}', E'${esc(text1)}', 'text/plain', ${Buffer.byteLength(text1)}, '${ts1}')`
  );
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows1 = await query(`SELECT id, path, summary, timestamp FROM "${TABLE}" WHERE path = '/test/file1.txt'`);
  assert(rows1.length === 1, "row inserted");
  assert(rows1[0].id === id1, `id matches (${rows1[0].id})`);
  assert(rows1[0].summary === text1, "summary matches");
  assert(rows1[0].timestamp === ts1, "timestamp matches");

  // ── Test 2: UPDATE existing row (preserves id, updates timestamp) ──────────
  console.log("\nTest 2: UPDATE existing row — id preserved, timestamp refreshed");
  await new Promise(r => setTimeout(r, 100)); // ensure different timestamp
  const ts2 = new Date().toISOString();
  const text2 = "updated content";
  const hex2 = Buffer.from(text2).toString("hex");
  await query(
    `UPDATE "${TABLE}" SET content = E'\\\\x${hex2}', summary = E'${esc(text2)}', ` +
    `mime_type = 'text/plain', size_bytes = ${Buffer.byteLength(text2)}, timestamp = '${ts2}' ` +
    `WHERE path = '/test/file1.txt'`
  );
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows2 = await query(`SELECT id, summary, timestamp FROM "${TABLE}" WHERE path = '/test/file1.txt'`);
  assert(rows2.length === 1, "still one row");
  assert(rows2[0].id === id1, `id preserved after UPDATE (${rows2[0].id})`);
  assert(rows2[0].summary === text2, "summary updated");
  assert(rows2[0].timestamp === ts2, `timestamp updated (${rows2[0].timestamp})`);

  // ── Test 3: appendFile UPDATE (concat content, update timestamp) ───────────
  console.log("\nTest 3: appendFile UPDATE — concat content, timestamp refreshed");
  await new Promise(r => setTimeout(r, 100));
  const ts3 = new Date().toISOString();
  const append = "\nappended line";
  const appendHex = Buffer.from(append).toString("hex");
  await query(
    `UPDATE "${TABLE}" SET ` +
    `summary = summary || E'${esc(append)}', ` +
    `content = content || E'\\\\x${appendHex}', ` +
    `size_bytes = size_bytes + ${Buffer.byteLength(append)}, ` +
    `timestamp = '${ts3}' ` +
    `WHERE path = '/test/file1.txt'`
  );
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows3 = await query(`SELECT id, summary, size_bytes, timestamp FROM "${TABLE}" WHERE path = '/test/file1.txt'`);
  assert(rows3.length === 1, "still one row");
  assert(rows3[0].id === id1, `id preserved after append (${rows3[0].id})`);
  assert(rows3[0].summary === text2 + append, `summary concatenated`);
  assert(rows3[0].timestamp === ts3, `timestamp updated (${rows3[0].timestamp})`);

  // ── Test 4: SELECT check before upsert (path exists) ──────────────────────
  console.log("\nTest 4: SELECT-based existence check for upsert");
  const exists = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/file1.txt' LIMIT 1`);
  assert(exists.length > 0, "existing path found");
  const notExists = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/nonexistent.txt' LIMIT 1`);
  assert(notExists.length === 0, "missing path returns empty");

  // ── Test 5: Full upsert flow — check then UPDATE ──────────────────────────
  console.log("\nTest 5: Full upsert — SELECT then UPDATE for existing path");
  await new Promise(r => setTimeout(r, 100));
  const ts5 = new Date().toISOString();
  const text5 = "upsert-updated";
  const hex5 = Buffer.from(text5).toString("hex");
  const check5 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/file1.txt' LIMIT 1`);
  if (check5.length > 0) {
    await query(
      `UPDATE "${TABLE}" SET content = E'\\\\x${hex5}', summary = E'${esc(text5)}', ` +
      `mime_type = 'text/plain', size_bytes = ${Buffer.byteLength(text5)}, timestamp = '${ts5}' ` +
      `WHERE path = '/test/file1.txt'`
    );
  }
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows5 = await query(`SELECT id, summary, timestamp FROM "${TABLE}" WHERE path = '/test/file1.txt'`);
  assert(rows5[0].id === id1, `id still preserved through upsert (${rows5[0].id})`);
  assert(rows5[0].summary === text5, "content replaced via upsert");
  assert(rows5[0].timestamp === ts5, "timestamp refreshed via upsert");

  // ── Test 6: Full upsert flow — SELECT then INSERT for new path ─────────────
  console.log("\nTest 6: Full upsert — SELECT then INSERT for new path");
  const id6 = randomUUID();
  const ts6 = new Date().toISOString();
  const text6 = "brand new file";
  const hex6 = Buffer.from(text6).toString("hex");
  const check6 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/file2.txt' LIMIT 1`);
  if (check6.length === 0) {
    await query(
      `INSERT INTO "${TABLE}" (id, path, filename, content, summary, mime_type, size_bytes, timestamp) ` +
      `VALUES ('${id6}', '/test/file2.txt', 'file2.txt', E'\\\\x${hex6}', E'${esc(text6)}', 'text/plain', ${Buffer.byteLength(text6)}, '${ts6}')`
    );
  }
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows6 = await query(`SELECT id, summary, timestamp FROM "${TABLE}" WHERE path = '/test/file2.txt'`);
  assert(rows6.length === 1, "new row inserted");
  assert(rows6[0].id === id6, `new id assigned (${rows6[0].id})`);
  assert(rows6[0].summary === text6, "content correct");

  // ── Test 7: Multiple updates preserve same id ──────────────────────────────
  console.log("\nTest 7: Multiple sequential updates preserve same id");
  for (let i = 0; i < 3; i++) {
    const ts = new Date().toISOString();
    const txt = `update-${i}`;
    const hx = Buffer.from(txt).toString("hex");
    await query(
      `UPDATE "${TABLE}" SET content = E'\\\\x${hx}', summary = E'${esc(txt)}', ` +
      `size_bytes = ${Buffer.byteLength(txt)}, timestamp = '${ts}' ` +
      `WHERE path = '/test/file1.txt'`
    );
  }
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows7 = await query(`SELECT id, summary FROM "${TABLE}" WHERE path = '/test/file1.txt'`);
  assert(rows7[0].id === id1, `id still original after 3 updates (${rows7[0].id})`);
  assert(rows7[0].summary === "update-2", "content is from last update");

  // ── Test 8: DELETE then re-INSERT gets new id ──────────────────────────────
  console.log("\nTest 8: After DELETE, re-INSERT gets a new id");
  await query(`DELETE FROM "${TABLE}" WHERE path = '/test/file2.txt'`);
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const id8 = randomUUID();
  const ts8 = new Date().toISOString();
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, content, summary, mime_type, size_bytes, timestamp) ` +
    `VALUES ('${id8}', '/test/file2.txt', 'file2.txt', E'\\\\x${hex6}', E'${esc(text6)}', 'text/plain', ${Buffer.byteLength(text6)}, '${ts8}')`
  );
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows8 = await query(`SELECT id FROM "${TABLE}" WHERE path = '/test/file2.txt'`);
  assert(rows8[0].id === id8, `new id after delete+insert (${rows8[0].id} !== old ${id6})`);

  // ── Test 9: UPDATE on non-existent path is a no-op ─────────────────────────
  console.log("\nTest 9: UPDATE on non-existent path is a no-op");
  await query(
    `UPDATE "${TABLE}" SET summary = E'ghost', timestamp = '${new Date().toISOString()}' ` +
    `WHERE path = '/test/does-not-exist.txt'`
  );
  await query(`SELECT deeplake_sync_table('${TABLE}')`);
  const rows9 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/does-not-exist.txt'`);
  assert(rows9.length === 0, "no row created by UPDATE on missing path");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

} finally {
  // ── Cleanup ────────────────────────────────────────────────────────────────
  console.log(`\nDropping table "${TABLE}"...`);
  try {
    await query(`DROP TABLE "${TABLE}"`);
    console.log("Cleaned up.");
  } catch (e) {
    console.error("Cleanup failed:", e.message);
  }
}

process.exit(failed > 0 ? 1 : 0);
