#!/usr/bin/env node

/**
 * Benchmark harness for Deeplake plugin — exercises REAL plugin code paths.
 *
 * Uses DeeplakeApi (the actual query client) for all DB operations.
 * Simulates the real session lifecycle:
 *   - ensureTable / ensureSessionsTable (the actual methods)
 *   - DeeplakeFs.create (bootstrap with sync + metadata load)
 *   - DeeplakeFs.writeFileWithMeta (batched flush)
 *   - DeeplakeFs.readFile (cache + SQL fetch)
 *   - DeeplakeFs.flush()
 *   - Capture INSERTs via DeeplakeApi.query (same as capture.ts)
 *
 * Usage:
 *   npm run build && node bench/run.mjs [--users 5,10] [--sessions 1,3] [--out results.json]
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Import the ACTUAL plugin code
import { DeeplakeApi } from "../dist/src/deeplake-api.js";
import { DeeplakeFs } from "../dist/src/shell/deeplake-fs.js";
import { sqlStr } from "../dist/src/utils/sql.js";

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = "https://api-beta.deeplake.ai";
const TOKEN = process.env.DEEPLAKE_BENCH_TOKEN;
const ORG_ID = process.env.DEEPLAKE_BENCH_ORG ?? "0e710368-56c2-482e-aa7f-e69815e878c8";

if (!TOKEN) {
  console.error("Set DEEPLAKE_BENCH_TOKEN env var");
  process.exit(1);
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const USER_COUNTS = (getArg("users") ?? "5,10,20,50,100").split(",").map(Number);
const SESSION_COUNTS = (getArg("sessions") ?? "1,3,5,10").split(",").map(Number);
const OUT_FILE = getArg("out") ?? "bench/results.json";
const QA_MIN = 5;
const QA_MAX = 10;
const MAX_STAGGER_MS = 3000;

// ── Metrics instrumentation ─────────────────────────────────────────────────

/** Wraps a DeeplakeApi instance to intercept query() calls and record metrics. */
function instrumentApi(api) {
  const metrics = [];
  const origQuery = api.query.bind(api);

  api.query = async function (sql) {
    const op = classifyQuery(sql);
    const start = performance.now();
    const ts = Date.now();
    try {
      const result = await origQuery(sql);
      metrics.push({ op, latencyMs: performance.now() - start, ok: true, ts });
      return result;
    } catch (e) {
      const latencyMs = performance.now() - start;
      metrics.push({ op, latencyMs, ok: false, error: e.message, ts });
      if (op !== "alter_table") {
        console.error(`  [ERR] ${op} (${latencyMs.toFixed(0)}ms): ${e.message.slice(0, 150)}`);
      }
      throw e;
    }
  };

  return metrics;
}

function classifyQuery(sql) {
  const s = sql.trim().toUpperCase();
  if (s.startsWith("CREATE TABLE")) return "create_table";
  if (s.startsWith("ALTER TABLE")) return "alter_table";
  if (s.startsWith("SELECT DEEPLAKE_SYNC")) return "sync_table";
  if (s.startsWith("INSERT")) return s.includes("SESSIONS") ? "capture_insert" : "memory_insert";
  if (s.startsWith("UPDATE")) return "memory_update";
  if (s.startsWith("DELETE")) return "memory_delete";
  if (s.includes("SUM(SIZE_BYTES)")) return "bootstrap_sessions";
  if (s.includes("SIZE_BYTES, MIME_TYPE")) return "bootstrap_metadata";
  if (s.includes("CONTENT_TEXT") && s.includes("CONTENT")) return "read_file_text";
  if (s.includes("CONTENT_TEXT") && !s.includes("CONTENT ")) return "read_content_text";
  if (s.includes("SELECT CONTENT FROM")) return "read_file_binary";
  if (s.includes("SELECT PATH FROM")) return "check_exists";
  if (s.includes("LIKE") && s.includes("SUMMARIES")) return "generate_index";
  return "other";
}

// ── Workspace management ────────────────────────────────────────────────────

async function createWorkspace(id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`${API_URL}/workspaces`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "X-Activeloop-Org-Id": ORG_ID,
        },
        body: JSON.stringify({ id, name: id }),
      });
      if (resp.ok) return;
      const text = await resp.text();
      if (text.includes("already exists")) return;
      if (attempt < 4 && [429, 500, 502, 503, 504].includes(resp.status)) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw new Error(`Failed to create workspace ${id}: ${resp.status} ${text}`);
    } catch (e) {
      if (attempt < 4 && e.message?.includes("fetch")) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
}

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE_QUESTIONS = [
  "How do I implement a binary search tree in Python?",
  "What is the difference between TCP and UDP?",
  "Explain the CAP theorem in distributed systems.",
  "How does garbage collection work in Go?",
  "What are the SOLID principles in software design?",
  "How do database indexes improve query performance?",
  "Explain the difference between processes and threads.",
  "What is eventual consistency and when should I use it?",
  "How does TLS/SSL handshake work?",
  "What are the trade-offs between SQL and NoSQL databases?",
];

const SAMPLE_ANSWERS = [
  "A binary search tree maintains sorted order with O(log n) operations for balanced trees...",
  "TCP provides reliable ordered delivery with connection setup; UDP is connectionless and faster but unreliable...",
  "The CAP theorem states that a distributed system can provide at most two of: Consistency, Availability, Partition tolerance...",
  "Go uses a concurrent tri-color mark-and-sweep garbage collector that runs alongside application goroutines...",
  "SOLID stands for Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion...",
  "Indexes create sorted data structures (B-trees) that allow the database to find rows without scanning the entire table...",
  "Processes have separate memory spaces and are isolated; threads share memory within a process and are lighter weight...",
  "Eventual consistency guarantees that all replicas will converge to the same state given enough time without new updates...",
  "TLS handshake: ClientHello → ServerHello + cert → key exchange → Finished. Establishes encrypted session...",
  "SQL excels at complex joins and ACID transactions; NoSQL offers horizontal scaling and flexible schemas...",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Session simulation using REAL plugin code ───────────────────────────────

async function simulateSession(api, fs, sessionsTable, userId, sessionIdx) {
  const sessionUuid = randomUUID().slice(0, 8);
  const sessionPath = `/sessions/user_${userId}/user_${userId}_bench_default_${sessionUuid}.jsonl`;
  const summaryPath = `/summaries/user_${userId}/${sessionUuid}.md`;
  const ts = () => new Date().toISOString();

  // 1. Session start — write placeholder via DeeplakeFs (exercises writeFileWithMeta + batch flush)
  const placeholderContent = `# Session ${sessionUuid}\n- **Started**: ${ts()}\n- **Status**: in-progress\n`;
  await fs.writeFileWithMeta(summaryPath, placeholderContent, {
    project: "benchmark",
    description: "in progress",
    creationDate: ts(),
    lastUpdateDate: ts(),
  });
  await fs.flush();

  // 2. Q&A rounds — capture via DeeplakeApi.query (same as capture.ts does)
  const rounds = QA_MIN + Math.floor(Math.random() * (QA_MAX - QA_MIN + 1));
  for (let i = 0; i < rounds; i++) {
    const q = pick(SAMPLE_QUESTIONS);
    const a = pick(SAMPLE_ANSWERS);
    const now = ts();

    // User prompt capture (mirrors capture.ts INSERT — using TEXT instead of JSONB for beta compat)
    const promptEntry = JSON.stringify({
      id: randomUUID(), session_id: sessionUuid, type: "user_message",
      content: q, timestamp: now, hook_event_name: "UserPromptSubmit",
    });
    const promptHex = Buffer.from(promptEntry, "utf-8").toString("hex");
    await api.query(
      `INSERT INTO "${sessionsTable}" (id, path, filename, content, content_text, mime_type, size_bytes, project, description, creation_date, last_update_date) ` +
      `VALUES ('${randomUUID()}', '${sqlStr(sessionPath)}', '${sessionUuid}.jsonl', E'\\\\x${promptHex}', E'${sqlStr(promptEntry)}', 'application/json', ` +
      `${Buffer.byteLength(promptEntry)}, 'benchmark', 'UserPromptSubmit', '${now}', '${now}')`
    );

    // Assistant response capture
    const responseEntry = JSON.stringify({
      id: randomUUID(), session_id: sessionUuid, type: "assistant_message",
      content: a, timestamp: ts(), hook_event_name: "Stop",
    });
    const responseHex = Buffer.from(responseEntry, "utf-8").toString("hex");
    await api.query(
      `INSERT INTO "${sessionsTable}" (id, path, filename, content, content_text, mime_type, size_bytes, project, description, creation_date, last_update_date) ` +
      `VALUES ('${randomUUID()}', '${sqlStr(sessionPath)}', '${sessionUuid}.jsonl', E'\\\\x${responseHex}', E'${sqlStr(responseEntry)}', 'application/json', ` +
      `${Buffer.byteLength(responseEntry)}, 'benchmark', 'Stop', '${ts()}', '${ts()}')`
    );
  }

  // 3. Read-back: read the summary we wrote (exercises DeeplakeFs.readFile + cache)
  try {
    await fs.readFile(summaryPath);
  } catch { /* may not be synced yet */ }

  // 4. Read-back: read another user's summary if it exists (exercises SQL fetch path)
  const otherUser = userId > 0 ? userId - 1 : userId + 1;
  const allPaths = fs.getAllPaths().filter(p => p.startsWith(`/summaries/user_${otherUser}/`));
  if (allPaths.length > 0) {
    try { await fs.readFile(allPaths[0]); } catch {}
  }

  // 5. Update summary to completed (exercises writeFileWithMeta UPDATE path)
  const finalContent = placeholderContent.replace("in-progress", "completed");
  await fs.writeFileWithMeta(summaryPath, finalContent, {
    project: "benchmark",
    description: "completed",
    lastUpdateDate: ts(),
  });
  await fs.flush();
}

// ── Experiment runner ───────────────────────────────────────────────────────

async function runExperiment(numUsers, sessionsPerUser) {
  const expId = `bench-v12-u${numUsers}-s${sessionsPerUser}`;
  console.log(`\n▶ Experiment: ${expId} (${numUsers} users × ${sessionsPerUser} sessions = ${numUsers * sessionsPerUser} total)`);

  // Create workspace
  await createWorkspace(expId);

  // Create the REAL DeeplakeApi client (same as the plugin uses)
  const memTable = "memory";
  const sessTable = "sessions";
  const api = new DeeplakeApi(TOKEN, API_URL, ORG_ID, expId, memTable);

  // Instrument to capture metrics
  const metrics = instrumentApi(api);

  // Use the REAL ensureTable (exercises listTables + CREATE)
  await api.ensureTable();
  // Create sessions table with same schema as memory (avoids JSONB permission issues on beta)
  await api.ensureTable(sessTable);

  // Bootstrap the REAL DeeplakeFs (exercises sync + metadata load)
  const fs = await DeeplakeFs.create(api, memTable, "/");

  // Build session tasks with random stagger
  const tasks = [];
  for (let u = 0; u < numUsers; u++) {
    for (let s = 0; s < sessionsPerUser; s++) {
      const delay = Math.random() * MAX_STAGGER_MS;
      tasks.push({ userId: u, sessionIdx: s, delay });
    }
  }

  const expStart = performance.now();

  // Launch all sessions concurrently with staggered starts
  // Each session shares the same DeeplakeFs instance (as it would in reality for a single agent,
  // though in practice each agent has its own). This tests the concurrent write batching.
  await Promise.allSettled(
    tasks.map(({ userId, sessionIdx, delay }) =>
      new Promise(resolve => setTimeout(resolve, delay)).then(() =>
        simulateSession(api, fs, sessTable, userId, `s${sessionIdx}`)
      )
    )
  );

  // Final flush
  try { await fs.flush(); } catch {}

  const expDurationMs = performance.now() - expStart;

  // Compute metrics
  const totalQueries = metrics.length;
  const errors = metrics.filter(m => !m.ok);
  const errorRate = totalQueries > 0 ? errors.length / totalQueries : 0;

  const byOp = {};
  for (const m of metrics) {
    if (!byOp[m.op]) byOp[m.op] = [];
    byOp[m.op].push(m);
  }

  function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
  }

  const opStats = {};
  for (const [op, entries] of Object.entries(byOp)) {
    const latencies = entries.map(e => e.latencyMs);
    const opErrors = entries.filter(e => !e.ok).length;
    opStats[op] = {
      count: entries.length,
      errors: opErrors,
      errorRate: entries.length > 0 ? opErrors / entries.length : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      min: Math.min(...latencies),
      max: Math.max(...latencies),
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    };
  }

  const allLatencies = metrics.filter(m => m.ok).map(m => m.latencyMs);

  const result = {
    experiment: expId,
    numUsers,
    sessionsPerUser,
    totalSessions: numUsers * sessionsPerUser,
    durationMs: expDurationMs,
    totalQueries,
    totalErrors: errors.length,
    errorRate,
    throughputQps: totalQueries / (expDurationMs / 1000),
    overall: allLatencies.length > 0 ? {
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      min: Math.min(...allLatencies),
      max: Math.max(...allLatencies),
      mean: allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length,
    } : null,
    byOperation: opStats,
    timeSeries: buildTimeSeries(metrics, expStart),
  };

  console.log(`  Duration: ${(expDurationMs / 1000).toFixed(1)}s | Queries: ${totalQueries} | Errors: ${errors.length} (${(errorRate * 100).toFixed(1)}%) | QPS: ${result.throughputQps.toFixed(1)}`);
  if (result.overall) {
    console.log(`  Latency p50=${result.overall.p50.toFixed(0)}ms p95=${result.overall.p95.toFixed(0)}ms p99=${result.overall.p99.toFixed(0)}ms`);
  }

  return result;
}

function buildTimeSeries(metrics, expStart) {
  if (metrics.length === 0) return [];
  const buckets = {};
  for (const m of metrics) {
    const sec = Math.floor((m.ts - (expStart + performance.timeOrigin)) / 1000);
    const key = Math.max(0, sec);
    if (!buckets[key]) buckets[key] = { second: key, count: 0, errors: 0, latencies: [] };
    buckets[key].count++;
    if (!m.ok) buckets[key].errors++;
    buckets[key].latencies.push(m.latencyMs);
  }
  return Object.values(buckets)
    .sort((a, b) => a.second - b.second)
    .map(b => ({
      second: b.second,
      count: b.count,
      errors: b.errors,
      meanLatencyMs: b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length,
      p95LatencyMs: (() => { const s = b.latencies.sort((a, c) => a - c); return s[Math.ceil(s.length * 0.95) - 1]; })(),
    }));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Deeplake Benchmark Harness (using REAL plugin code)`);
  console.log(`API: ${API_URL} | Org: ${ORG_ID}`);
  console.log(`Users: [${USER_COUNTS}] | Sessions: [${SESSION_COUNTS}]`);
  console.log(`Total experiments: ${USER_COUNTS.length * SESSION_COUNTS.length}`);

  const results = [];

  for (const users of USER_COUNTS) {
    for (const sessions of SESSION_COUNTS) {
      try {
        const result = await runExperiment(users, sessions);
        results.push(result);
      } catch (e) {
        console.error(`  ✗ Experiment u${users}-s${sessions} failed: ${e.message}`);
        results.push({
          experiment: `bench-u${users}-s${sessions}`,
          numUsers: users,
          sessionsPerUser: sessions,
          error: e.message,
        });
      }
    }
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${OUT_FILE}`);

  console.log("\n═══ Summary ═══");
  console.log("Experiment           | Sessions | Queries | Errors | QPS    | p50ms | p95ms | p99ms");
  console.log("─────────────────────|----------|---------|--------|--------|-------|-------|------");
  for (const r of results) {
    if (r.error) {
      console.log(`${r.experiment.padEnd(21)}| FAILED: ${r.error}`);
      continue;
    }
    console.log(
      `${r.experiment.padEnd(21)}| ${String(r.totalSessions).padEnd(9)}| ${String(r.totalQueries).padEnd(8)}| ${String(r.totalErrors).padEnd(7)}| ${r.throughputQps.toFixed(1).padEnd(7)}| ${r.overall?.p50?.toFixed(0)?.padEnd(6) ?? "N/A   "}| ${r.overall?.p95?.toFixed(0)?.padEnd(6) ?? "N/A   "}| ${r.overall?.p99?.toFixed(0) ?? "N/A"}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
