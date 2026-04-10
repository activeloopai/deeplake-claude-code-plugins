#!/usr/bin/env node
/**
 * E2E test: exercises the text-only schema (no BYTEA content column)
 * against a real Deeplake table. Uses a temporary test table, cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const creds = JSON.parse(readFileSync(join(homedir(), ".deeplake/credentials.json"), "utf-8"));
const TABLE = "test_textonly_" + Date.now();
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
  // ── Setup: text-only schema (no BYTEA content column) ─────────────────────
  console.log(`\nCreating table "${TABLE}" (text-only schema)...`);
  await query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" (` +
    `id TEXT NOT NULL DEFAULT '', ` +
    `path TEXT NOT NULL DEFAULT '', ` +
    `filename TEXT NOT NULL DEFAULT '', ` +
    `summary TEXT NOT NULL DEFAULT '', ` +
    `author TEXT NOT NULL DEFAULT '', ` +
    `mime_type TEXT NOT NULL DEFAULT 'text/plain', ` +
    `size_bytes BIGINT NOT NULL DEFAULT 0, ` +
    `project TEXT NOT NULL DEFAULT '', ` +
    `description TEXT NOT NULL DEFAULT '', ` +
    `creation_date TEXT NOT NULL DEFAULT '', ` +
    `last_update_date TEXT NOT NULL DEFAULT ''` +
    `) USING deeplake`
  );
  console.log("Table created.\n");

  // ── Test 1: INSERT new row (text only, no hex) ────────────────────────────
  console.log("Test 1: INSERT new row (text-only)");
  const id1 = randomUUID();
  const ts1 = new Date().toISOString();
  const text1 = "# Hello World\nThis is a test file.";
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, summary, author, mime_type, size_bytes, creation_date, last_update_date) ` +
    `VALUES ('${id1}', '/test/file1.md', 'file1.md', E'${esc(text1)}', 'test-user', 'text/markdown', ${Buffer.byteLength(text1)}, '${ts1}', '${ts1}')`
  );
  await sync();
  const rows1 = await query(`SELECT id, path, summary, author, creation_date FROM "${TABLE}" WHERE path = '/test/file1.md'`);
  assert(rows1.length === 1, "row inserted");
  assert(rows1[0].id === id1, `id matches`);
  assert(rows1[0].summary === text1, "summary matches");
  assert(rows1[0].author === "test-user", "author matches");
  assert(rows1[0].creation_date === ts1, "creation_date matches");

  // ── Test 2: UPDATE existing row ───────────────────────────────────────────
  console.log("\nTest 2: UPDATE existing row — id preserved, content replaced");
  await new Promise(r => setTimeout(r, 100));
  const ts2 = new Date().toISOString();
  const text2 = "# Updated\nNew content here.";
  await query(
    `UPDATE "${TABLE}" SET summary = E'${esc(text2)}', ` +
    `size_bytes = ${Buffer.byteLength(text2)}, last_update_date = '${ts2}' ` +
    `WHERE path = '/test/file1.md'`
  );
  await sync();
  const rows2 = await query(`SELECT id, summary, last_update_date FROM "${TABLE}" WHERE path = '/test/file1.md'`);
  assert(rows2.length === 1, "still one row");
  assert(rows2[0].id === id1, `id preserved after UPDATE`);
  assert(rows2[0].summary === text2, "summary updated");
  assert(rows2[0].last_update_date === ts2, "last_update_date refreshed");

  // ── Test 3: appendFile — SQL-level text concat ────────────────────────────
  console.log("\nTest 3: appendFile — SQL text concat (no hex)");
  await new Promise(r => setTimeout(r, 100));
  const ts3 = new Date().toISOString();
  const append = "\n## Appended Section\nExtra content.";
  await query(
    `UPDATE "${TABLE}" SET ` +
    `summary = summary || E'${esc(append)}', ` +
    `size_bytes = size_bytes + ${Buffer.byteLength(append)}, ` +
    `last_update_date = '${ts3}' ` +
    `WHERE path = '/test/file1.md'`
  );
  await sync();
  const rows3 = await query(`SELECT id, summary, size_bytes FROM "${TABLE}" WHERE path = '/test/file1.md'`);
  assert(rows3.length === 1, "still one row");
  assert(rows3[0].id === id1, `id preserved after append`);
  assert(rows3[0].summary === text2 + append, "summary concatenated correctly");
  assert(rows3[0].size_bytes === Buffer.byteLength(text2 + append), "size_bytes updated");

  // ── Test 4: Upsert flow — SELECT then UPDATE ─────────────────────────────
  console.log("\nTest 4: Upsert — SELECT then UPDATE for existing path");
  await new Promise(r => setTimeout(r, 100));
  const ts4 = new Date().toISOString();
  const text4 = "upsert-overwrite";
  const check4 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/file1.md' LIMIT 1`);
  assert(check4.length > 0, "existing path found");
  await query(
    `UPDATE "${TABLE}" SET summary = E'${esc(text4)}', ` +
    `size_bytes = ${Buffer.byteLength(text4)}, last_update_date = '${ts4}' ` +
    `WHERE path = '/test/file1.md'`
  );
  await sync();
  const rows4 = await query(`SELECT id, summary FROM "${TABLE}" WHERE path = '/test/file1.md'`);
  assert(rows4[0].id === id1, "id preserved through upsert");
  assert(rows4[0].summary === text4, "content replaced via upsert");

  // ── Test 5: Upsert flow — SELECT then INSERT for new path ────────────────
  console.log("\nTest 5: Upsert — INSERT for new path");
  const id5 = randomUUID();
  const ts5 = new Date().toISOString();
  const text5 = "# Second File\nBrand new.";
  const check5 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/file2.md' LIMIT 1`);
  assert(check5.length === 0, "path does not exist yet");
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, summary, author, mime_type, size_bytes, project, description, creation_date, last_update_date) ` +
    `VALUES ('${id5}', '/test/file2.md', 'file2.md', E'${esc(text5)}', 'alice', 'text/markdown', ${Buffer.byteLength(text5)}, 'my-project', 'test file', '${ts5}', '${ts5}')`
  );
  await sync();
  const rows5 = await query(`SELECT id, summary, author, project, description FROM "${TABLE}" WHERE path = '/test/file2.md'`);
  assert(rows5.length === 1, "new row inserted");
  assert(rows5[0].id === id5, "correct id");
  assert(rows5[0].summary === text5, "content correct");
  assert(rows5[0].author === "alice", "author set");
  assert(rows5[0].project === "my-project", "project set");
  assert(rows5[0].description === "test file", "description set");

  // ── Test 6: Multiple updates preserve id ──────────────────────────────────
  console.log("\nTest 6: Multiple sequential updates preserve id");
  for (let i = 0; i < 3; i++) {
    const ts = new Date().toISOString();
    const txt = `revision-${i}`;
    await query(
      `UPDATE "${TABLE}" SET summary = E'${esc(txt)}', ` +
      `size_bytes = ${Buffer.byteLength(txt)}, last_update_date = '${ts}' ` +
      `WHERE path = '/test/file1.md'`
    );
  }
  await sync();
  const rows6 = await query(`SELECT id, summary FROM "${TABLE}" WHERE path = '/test/file1.md'`);
  assert(rows6[0].id === id1, "id still original after 3 updates");
  assert(rows6[0].summary === "revision-2", "content is from last update");

  // ── Test 7: DELETE then re-INSERT gets new id ─────────────────────────────
  console.log("\nTest 7: DELETE + re-INSERT gets new id");
  await query(`DELETE FROM "${TABLE}" WHERE path = '/test/file2.md'`);
  await sync();
  const id7 = randomUUID();
  const ts7 = new Date().toISOString();
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, summary, mime_type, size_bytes, creation_date, last_update_date) ` +
    `VALUES ('${id7}', '/test/file2.md', 'file2.md', E'${esc(text5)}', 'text/markdown', ${Buffer.byteLength(text5)}, '${ts7}', '${ts7}')`
  );
  await sync();
  const rows7 = await query(`SELECT id FROM "${TABLE}" WHERE path = '/test/file2.md'`);
  assert(rows7[0].id === id7, `new id after delete+insert (got ${rows7[0].id})`);

  // ── Test 8: UPDATE on non-existent path is a no-op ────────────────────────
  console.log("\nTest 8: UPDATE on non-existent path is a no-op");
  await query(
    `UPDATE "${TABLE}" SET summary = E'ghost', last_update_date = '${new Date().toISOString()}' ` +
    `WHERE path = '/test/does-not-exist.md'`
  );
  await sync();
  const rows8 = await query(`SELECT path FROM "${TABLE}" WHERE path = '/test/does-not-exist.md'`);
  assert(rows8.length === 0, "no row created by UPDATE on missing path");

  // ── Test 9: Special characters in content ─────────────────────────────────
  console.log("\nTest 9: Special characters — quotes, backslashes, unicode");
  const id9 = randomUUID();
  const text9 = "It's a \"test\" with \\backslashes\\ and émojis 🎉";
  await query(
    `INSERT INTO "${TABLE}" (id, path, filename, summary, mime_type, size_bytes, creation_date, last_update_date) ` +
    `VALUES ('${id9}', '/test/special.md', 'special.md', E'${esc(text9)}', 'text/markdown', ${Buffer.byteLength(text9)}, '${new Date().toISOString()}', '${new Date().toISOString()}')`
  );
  await sync();
  const rows9 = await query(`SELECT summary FROM "${TABLE}" WHERE path = '/test/special.md'`);
  assert(rows9.length === 1, "row with special chars inserted");
  assert(rows9[0].summary === text9, `special chars roundtripped: ${rows9[0].summary}`);

  // ── Test 10: No BYTEA column in schema ────────────────────────────────────
  console.log("\nTest 10: Schema has no BYTEA content column");
  const cols = await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${TABLE}'`
  );
  const colNames = cols.map(c => c.column_name);
  assert(!colNames.includes("content"), "no 'content' column in schema");
  assert(colNames.includes("summary"), "has 'summary' column");
  assert(colNames.includes("author"), "has 'author' column");
  const summaryCol = cols.find(c => c.column_name === "summary");
  assert(summaryCol?.data_type === "text", `summary is TEXT (got ${summaryCol?.data_type})`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log(`\nDropping table "${TABLE}"...`);
  try {
    await query(`DROP TABLE "${TABLE}"`);
    console.log("Cleaned up.");
  } catch (e) {
    console.error("Cleanup failed:", e.message);
  }
}

process.exit(failed > 0 ? 1 : 0);
