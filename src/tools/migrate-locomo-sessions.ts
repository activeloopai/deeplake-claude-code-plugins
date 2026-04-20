#!/usr/bin/env node

import { basename } from "node:path";
import { loadCredentials } from "../commands/auth.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { buildSessionInsertSql, type QueuedSessionRow } from "../hooks/session-queue.js";

interface Args {
  sessionsTable: string;
  backupTable: string;
  batchSize: number;
  dryRun: boolean;
}

interface SessionRowRecord extends Record<string, unknown> {
  id: string;
  path: string;
  filename: string;
  message: unknown;
  author: string;
  size_bytes: number;
  project: string;
  description: string;
  agent: string;
  creation_date: string;
  last_update_date: string;
}

const LOCOMO_PATH_FILTER = `/sessions/conv_%_session_%.json%`;

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const opts: Args = {
    sessionsTable: "sessions",
    backupTable: "sessions_locomo_blob_backup",
    batchSize: 100,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--sessions-table":
        opts.sessionsTable = args[++i] ?? opts.sessionsTable;
        break;
      case "--backup-table":
        opts.backupTable = args[++i] ?? opts.backupTable;
        break;
      case "--batch-size":
        opts.batchSize = Math.max(1, Number(args[++i]) || opts.batchSize);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
    }
  }
  return opts;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function extractNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isTranscriptBlob(row: SessionRowRecord): boolean {
  const parsed = parseJson(row.message);
  return !!parsed && (Array.isArray(parsed["turns"]) || Array.isArray(parsed["dialogue"]));
}

function normalizeMessageJson(value: unknown): string {
  try {
    return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return JSON.stringify({ type: "raw_message", content: String(value ?? "") });
  }
}

function toQueuedRowFromExisting(row: SessionRowRecord): QueuedSessionRow {
  const message = normalizeMessageJson(row.message);
  return {
    id: extractString(row.id),
    path: extractString(row.path),
    filename: extractString(row.filename),
    message,
    sessionId: extractString(parseJson(row.message)?.["session_id"]) || basename(extractString(row.path)).replace(/\.[^.]+$/, ""),
    eventType: extractString(parseJson(row.message)?.["type"]),
    turnIndex: extractNumber(parseJson(row.message)?.["turn_index"]),
    diaId: extractString(parseJson(row.message)?.["dia_id"]),
    speaker: extractString(parseJson(row.message)?.["speaker"]),
    text: extractString(parseJson(row.message)?.["text"]) || extractString(parseJson(row.message)?.["content"]),
    turnSummary: extractString(parseJson(row.message)?.["summary"]) || extractString(parseJson(row.message)?.["message_summary"]),
    sourceDateTime: extractString(parseJson(row.message)?.["date_time"]) || extractString(parseJson(row.message)?.["source_date_time"]),
    author: extractString(row.author),
    sizeBytes: extractNumber(row.size_bytes),
    project: extractString(row.project),
    description: extractString(row.description),
    agent: extractString(row.agent),
    creationDate: extractString(row.creation_date),
    lastUpdateDate: extractString(row.last_update_date),
  };
}

function explodeTranscriptRow(row: SessionRowRecord): QueuedSessionRow[] {
  const parsed = parseJson(row.message);
  if (!parsed) return [];
  const turns = Array.isArray(parsed["turns"])
    ? parsed["turns"] as Array<Record<string, unknown>>
    : Array.isArray(parsed["dialogue"])
      ? parsed["dialogue"] as Array<Record<string, unknown>>
      : [];
  const sessionId = basename(extractString(row.path)).replace(/\.[^.]+$/, "");
  const sourceDateTime = extractString(parsed["date_time"]) || extractString(parsed["date"]) || extractString(row.creation_date);

  return turns.map((turn, index) => {
    const messageObject = {
      type: "dialogue_turn",
      session_id: sessionId,
      source_path: extractString(row.path),
      conversation_id: parsed["conversation_id"] ?? null,
      session_number: parsed["session_number"] ?? null,
      date_time: sourceDateTime || null,
      turn_index: index + 1,
      dia_id: turn["dia_id"] ?? null,
      speaker: turn["speaker"] ?? turn["name"] ?? null,
      text: turn["text"] ?? turn["content"] ?? null,
      summary: turn["summary"] ?? turn["message_summary"] ?? null,
    };
    const message = JSON.stringify(messageObject);
    return {
      id: crypto.randomUUID(),
      path: extractString(row.path),
      filename: extractString(row.filename),
      message,
      sessionId,
      eventType: "dialogue_turn",
      turnIndex: index + 1,
      diaId: extractString(turn["dia_id"]),
      speaker: extractString(turn["speaker"]) || extractString(turn["name"]),
      text: extractString(turn["text"]) || extractString(turn["content"]),
      turnSummary: extractString(turn["summary"]) || extractString(turn["message_summary"]),
      sourceDateTime,
      author: extractString(row.author) || "locomo",
      sizeBytes: Buffer.byteLength(message, "utf-8"),
      project: extractString(row.project) || "locomo",
      description: "dialogue_turn",
      agent: extractString(row.agent) || "claude_code",
      creationDate: extractString(row.creation_date) || sourceDateTime,
      lastUpdateDate: extractString(row.last_update_date) || extractString(row.creation_date) || sourceDateTime,
    };
  });
}

async function insertRows(api: DeeplakeApi, table: string, rows: QueuedSessionRow[], batchSize: number): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await api.query(buildSessionInsertSql(table, rows.slice(i, i + batchSize)));
  }
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
    opts.sessionsTable,
  );

  await api.ensureSessionsTable(opts.sessionsTable);
  await api.ensureSessionsTable(opts.backupTable);

  const backupRows = await api.query(
    `SELECT id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date ` +
    `FROM "${opts.backupTable}" WHERE path LIKE '${LOCOMO_PATH_FILTER}' ORDER BY path, creation_date`
  ) as SessionRowRecord[];

  let sourceRows = backupRows;
  if (sourceRows.length === 0) {
    sourceRows = await api.query(
      `SELECT id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date ` +
      `FROM "${opts.sessionsTable}" WHERE path LIKE '${LOCOMO_PATH_FILTER}' ORDER BY path, creation_date`
    ) as SessionRowRecord[];

    if (sourceRows.length === 0) {
      console.log("No LOCOMO session rows found to migrate.");
      return;
    }

    if (!opts.dryRun) {
      console.log(`Backing up ${sourceRows.length} original LOCOMO session rows to "${opts.backupTable}"...`);
      await insertRows(api, opts.backupTable, sourceRows.map(toQueuedRowFromExisting), opts.batchSize);
    }
  }

  const transcriptBlobRows = sourceRows.filter(isTranscriptBlob);
  const migratedRows = transcriptBlobRows.flatMap(explodeTranscriptRow);

  console.log(`Workspace: ${creds.workspaceId ?? "default"} | Sessions table: ${opts.sessionsTable}`);
  console.log(`Original LOCOMO blob rows: ${transcriptBlobRows.length}`);
  console.log(`Expanded turn rows: ${migratedRows.length}`);

  if (opts.dryRun) return;

  console.log(`Deleting existing LOCOMO rows from "${opts.sessionsTable}"...`);
  await api.query(`DELETE FROM "${opts.sessionsTable}" WHERE path LIKE '${LOCOMO_PATH_FILTER}'`);

  console.log(`Inserting ${migratedRows.length} migrated turn rows into "${opts.sessionsTable}"...`);
  await insertRows(api, opts.sessionsTable, migratedRows, opts.batchSize);

  const finalRows = await api.query(
    `SELECT path, COUNT(*) AS row_count FROM "${opts.sessionsTable}" WHERE path LIKE '${LOCOMO_PATH_FILTER}' GROUP BY path ORDER BY path`
  );
  console.log(`Done. migrated_paths=${finalRows.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
