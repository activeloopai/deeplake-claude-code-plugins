#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { loadCredentials } from "../commands/auth.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { uploadSummary } from "../hooks/upload-summary.js";
import { WIKI_PROMPT_TEMPLATE, findClaudeBin } from "../hooks/spawn-wiki-worker.js";

const execFileAsync = promisify(execFile);

interface SessionRow {
  path: string;
  filename: string;
  creation_date?: string;
  source_date_time?: string;
  turn_index?: number;
  dia_id?: string;
  speaker?: string;
  text?: string;
  turn_summary?: string;
  event_type?: string;
  message: unknown;
}

interface SessionTask {
  sessionId: string;
  sourcePath: string;
  summaryPath: string;
  summaryFilename: string;
  jsonlContent: string;
  jsonlLines: number;
}

interface Args {
  sessionsTable: string;
  memoryTable: string;
  concurrency: number;
  model: string;
  clearMemory: boolean;
}

const VISIBILITY_RETRIES = 5;
const VISIBILITY_DELAY_MS = 1500;
const REPAIR_ROUNDS = 2;

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const opts: Args = {
    sessionsTable: "sessions",
    memoryTable: "memory",
    concurrency: 5,
    model: "haiku",
    clearMemory: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--sessions-table":
        opts.sessionsTable = args[++i];
        break;
      case "--memory-table":
        opts.memoryTable = args[++i];
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, parseInt(args[++i], 10) || 5);
        break;
      case "--model":
        opts.model = args[++i] || "haiku";
        break;
      case "--no-clear-memory":
        opts.clearMemory = false;
        break;
    }
  }

  return opts;
}

function parseSessionPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { raw };
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return { raw };
}

function buildSessionTaskFromBlob(row: SessionRow): SessionTask {
  const sessionId = basename(row.path).replace(/\.[^.]+$/, "");
  const summaryFilename = `${sessionId}_summary.md`;
  const summaryPath = `/summaries/locomo/${summaryFilename}`;
  const payload = parseSessionPayload(row.message);
  const turns = Array.isArray(payload["turns"]) ? payload["turns"] as Array<Record<string, unknown>> : [];

  if (turns.length === 0) {
    return {
      sessionId,
      sourcePath: row.path,
      summaryPath,
      summaryFilename,
      jsonlContent: `${typeof row.message === "string" ? row.message : JSON.stringify(row.message)}\n`,
      jsonlLines: 1,
    };
  }

  const speakers = payload["speakers"] && typeof payload["speakers"] === "object"
    ? payload["speakers"] as Record<string, unknown>
    : {};
  const meta = {
    type: "session_meta",
    session_id: sessionId,
    source_path: row.path,
    conversation_id: payload["conversation_id"] ?? null,
    session_number: payload["session_number"] ?? null,
    date_time: payload["date_time"] ?? payload["date"] ?? null,
    speaker_a: speakers["speaker_a"] ?? null,
    speaker_b: speakers["speaker_b"] ?? null,
  };

  const lines = [JSON.stringify(meta)];
  for (const turn of turns) {
    lines.push(JSON.stringify({
      type: "dialogue_turn",
      session_id: sessionId,
      date_time: payload["date_time"] ?? payload["date"] ?? null,
      speaker: turn["speaker"] ?? null,
      dia_id: turn["dia_id"] ?? null,
      text: turn["text"] ?? null,
    }));
  }

  return {
    sessionId,
    sourcePath: row.path,
    summaryPath,
    summaryFilename,
    jsonlContent: `${lines.join("\n")}\n`,
    jsonlLines: lines.length,
  };
}

function buildSessionTaskFromRows(rows: SessionRow[]): SessionTask {
  if (rows.length === 0) throw new Error("buildSessionTaskFromRows requires at least one row");
  const sorted = [...rows].sort((a, b) => {
    const turnA = typeof a.turn_index === "number" ? a.turn_index : Number.MAX_SAFE_INTEGER;
    const turnB = typeof b.turn_index === "number" ? b.turn_index : Number.MAX_SAFE_INTEGER;
    if (turnA !== turnB) return turnA - turnB;
    return (a.creation_date ?? "").localeCompare(b.creation_date ?? "");
  });
  const first = sorted[0];
  const sessionId = basename(first.path).replace(/\.[^.]+$/, "");
  const summaryFilename = `${sessionId}_summary.md`;
  const summaryPath = `/summaries/locomo/${summaryFilename}`;
  const sessionDateTime = first.source_date_time ?? first.creation_date ?? null;

  const lines = [JSON.stringify({
    type: "session_meta",
    session_id: sessionId,
    source_path: first.path,
    date_time: sessionDateTime,
  })];

  for (const row of sorted) {
    if ((row.event_type && row.event_type !== "dialogue_turn") && !row.text) continue;
    lines.push(JSON.stringify({
      type: row.event_type || "dialogue_turn",
      session_id: sessionId,
      date_time: row.source_date_time ?? row.creation_date ?? null,
      turn_index: row.turn_index ?? null,
      dia_id: row.dia_id ?? null,
      speaker: row.speaker ?? null,
      text: row.text ?? null,
      summary: row.turn_summary ?? null,
    }));
  }

  return {
    sessionId,
    sourcePath: first.path,
    summaryPath,
    summaryFilename,
    jsonlContent: `${lines.join("\n")}\n`,
    jsonlLines: lines.length,
  };
}

function buildPrompt(task: SessionTask): string {
  return WIKI_PROMPT_TEMPLATE
    .replace(/__JSONL__/g, "__TMP_JSONL__")
    .replace(/__SUMMARY__/g, "__TMP_SUMMARY__")
    .replace(/__SESSION_ID__/g, task.sessionId)
    .replace(/__PROJECT__/g, "locomo")
    .replace(/__PREV_OFFSET__/g, "0")
    .replace(/__JSONL_LINES__/g, String(task.jsonlLines))
    .replace(/__JSONL_SERVER_PATH__/g, task.sourcePath);
}

async function generateSummary(task: SessionTask, claudeBin: string, model: string): Promise<string> {
  const tmpRoot = await mkdtemp(join(tmpdir(), `locomo-summary-${task.sessionId}-`));
  const tmpJsonl = join(tmpRoot, "session.jsonl");
  const tmpSummary = join(tmpRoot, "summary.md");

  try {
    await writeFile(tmpJsonl, task.jsonlContent, "utf-8");
    const prompt = buildPrompt(task)
      .replace(/__TMP_JSONL__/g, tmpJsonl)
      .replace(/__TMP_SUMMARY__/g, tmpSummary);

    await execFileAsync(claudeBin, [
      "-p",
      prompt,
      "--no-session-persistence",
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
    ], {
      timeout: 120_000,
      env: {
        ...process.env,
        DEEPLAKE_CAPTURE: "false",
        HIVEMIND_CAPTURE: "false",
        HIVEMIND_WIKI_WORKER: "1",
        DEEPLAKE_WIKI_WORKER: "1",
      },
    });

    return await readFile(tmpSummary, "utf-8");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function generateSummaryWithRetry(task: SessionTask, claudeBin: string, model: string, retries = 2): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await generateSummary(task, claudeBin, model);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function listExistingSummaryPaths(api: DeeplakeApi, memoryTable: string): Promise<Set<string>> {
  const existingRows = await api.query(
    `SELECT path FROM "${memoryTable}" WHERE path LIKE '/summaries/locomo/%'`
  );
  return new Set(
    existingRows
      .map((row) => row["path"])
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

async function waitForVisibleSummaryPath(
  api: DeeplakeApi,
  memoryTable: string,
  summaryPath: string,
  retries = VISIBILITY_RETRIES,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const rows = await api.query(
      `SELECT path FROM "${memoryTable}" WHERE path = '${summaryPath.replace(/\\/g, "\\\\").replace(/'/g, "''")}' LIMIT 1`
    );
    if (rows.length > 0) return true;
    if (attempt < retries) await sleep(VISIBILITY_DELAY_MS * (attempt + 1));
  }
  return false;
}

async function uploadSummaryWithVerification(
  api: DeeplakeApi,
  memoryTable: string,
  task: SessionTask,
  text: string,
  retries = 2,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await uploadSummary(api.query.bind(api), {
        tableName: memoryTable,
        vpath: task.summaryPath,
        fname: task.summaryFilename,
        userName: "locomo",
        project: "locomo",
        agent: "claude_code",
        sessionId: task.sessionId,
        text,
      });
      const visible = await waitForVisibleSummaryPath(api, memoryTable, task.summaryPath);
      if (visible) return;
      lastError = new Error("summary row not visible after upload");
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await sleep(2000 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>) {
  let running = 0;
  let next = 0;
  await new Promise<void>((resolve) => {
    function launch() {
      while (running < concurrency && next < items.length) {
        const idx = next++;
        running++;
        fn(items[idx], idx)
          .finally(() => {
            running--;
            if (next >= items.length && running === 0) resolve();
            else launch();
          });
      }
    }
    launch();
  });
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const creds = loadCredentials();
  if (!creds?.token) {
    throw new Error("No Deeplake credentials found. Run hivemind login first.");
  }

  const api = new DeeplakeApi(
    creds.token,
    creds.apiUrl ?? "https://api.deeplake.ai",
    creds.orgId,
    creds.workspaceId ?? "default",
    opts.memoryTable,
  );

  const claudeBin = findClaudeBin();
  const sessionRowsRaw = await api.query(
    `SELECT path, filename, creation_date, source_date_time, turn_index, dia_id, speaker, text, turn_summary, event_type, message ` +
    `FROM "${opts.sessionsTable}" WHERE path LIKE '/sessions/conv_%_session_%.json%' ` +
    `ORDER BY path, creation_date, turn_index`
  );
  const sessionRows = sessionRowsRaw
    .filter((row) =>
      typeof row["path"] === "string" &&
      typeof row["filename"] === "string" &&
      "message" in row,
    )
    .map((row) => ({
      path: row["path"] as string,
      filename: row["filename"] as string,
      creation_date: typeof row["creation_date"] === "string" ? row["creation_date"] as string : undefined,
      source_date_time: typeof row["source_date_time"] === "string" ? row["source_date_time"] as string : undefined,
      turn_index: typeof row["turn_index"] === "number" ? row["turn_index"] as number : undefined,
      dia_id: typeof row["dia_id"] === "string" ? row["dia_id"] as string : undefined,
      speaker: typeof row["speaker"] === "string" ? row["speaker"] as string : undefined,
      text: typeof row["text"] === "string" ? row["text"] as string : undefined,
      turn_summary: typeof row["turn_summary"] === "string" ? row["turn_summary"] as string : undefined,
      event_type: typeof row["event_type"] === "string" ? row["event_type"] as string : undefined,
      message: row["message"],
    })) as SessionRow[];

  const grouped = new Map<string, SessionRow[]>();
  for (const row of sessionRows) {
    if (!row.path.includes("/conv_")) continue;
    const list = grouped.get(row.path) ?? [];
    list.push(row);
    grouped.set(row.path, list);
  }

  const allTasks = [...grouped.values()].map((rows) => {
    const blobRow = rows.find((row) => {
      const payload = parseSessionPayload(row.message);
      return Array.isArray(payload["turns"]) || Array.isArray(payload["dialogue"]);
    });
    return blobRow ? buildSessionTaskFromBlob(blobRow) : buildSessionTaskFromRows(rows);
  });
  let tasks = [...allTasks];
  const tasksByPath = new Map(allTasks.map((task) => [task.summaryPath, task]));
  const expectedPaths = new Set(allTasks.map((task) => task.summaryPath));

  console.log(`Workspace: ${creds.workspaceId ?? "default"} | Org: ${creds.orgName ?? creds.orgId}`);
  console.log(`Sessions table: ${opts.sessionsTable} | Memory table: ${opts.memoryTable}`);
  console.log(`Model: ${opts.model} | Concurrency: ${opts.concurrency}`);
  console.log(`Found ${tasks.length} LOCOMO sessions`);

  if (opts.clearMemory) {
    console.log(`Clearing "${opts.memoryTable}" before backfill...`);
    await api.query(`DELETE FROM "${opts.memoryTable}"`);
  } else {
    const existingPaths = await listExistingSummaryPaths(api, opts.memoryTable);
    const before = tasks.length;
    tasks = tasks.filter((task) => !existingPaths.has(task.summaryPath));
    console.log(`Existing LOCOMO summaries: ${existingPaths.size}. Pending tasks: ${tasks.length}/${before}`);
  }

  let completed = 0;
  let failed = 0;
  const failures: string[] = [];

  await withConcurrency(tasks, opts.concurrency, async (task) => {
    try {
      const text = await generateSummaryWithRetry(task, claudeBin, opts.model);
      if (!text.trim()) throw new Error("empty summary");

      await uploadSummaryWithVerification(api, opts.memoryTable, task, text);

      completed++;
      if (completed % 10 === 0 || completed === tasks.length) {
        console.log(`  ${completed}/${tasks.length}`);
      }
    } catch (error) {
      failed++;
      failures.push(`${task.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`FAIL ${task.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  let existingPaths = await listExistingSummaryPaths(api, opts.memoryTable);
  let missingPaths = [...expectedPaths].filter((path) => !existingPaths.has(path));

  for (let round = 1; round <= REPAIR_ROUNDS && missingPaths.length > 0; round++) {
    console.log(`Repair round ${round}: ${missingPaths.length} missing summaries`);
    await withConcurrency(
      missingPaths
        .map((path) => tasksByPath.get(path))
        .filter((task): task is SessionTask => Boolean(task)),
      1,
      async (task) => {
        try {
          const text = await generateSummaryWithRetry(task, claudeBin, opts.model);
          if (!text.trim()) throw new Error("empty summary");
          await uploadSummaryWithVerification(api, opts.memoryTable, task, text, 3);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${task.sessionId}: repair round ${round}: ${message}`);
          console.error(`FAIL ${task.sessionId} (repair ${round}): ${message}`);
        }
      },
    );
    existingPaths = await listExistingSummaryPaths(api, opts.memoryTable);
    missingPaths = [...expectedPaths].filter((path) => !existingPaths.has(path));
  }

  const finalCount = existingPaths.size;
  console.log(`Done. summaries=${completed} failed=${failed} memory_rows=${finalCount}`);
  if (missingPaths.length > 0) {
    console.error(`Still missing ${missingPaths.length} summaries:`);
    for (const path of missingPaths.slice(0, 20)) console.error(`  ${path}`);
    process.exitCode = 1;
  }
  if (failures.length > 0) {
    console.error(`Failures (${failures.length}):`);
    for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
