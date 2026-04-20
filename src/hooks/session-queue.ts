import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sqlIdent, sqlStr } from "../utils/sql.js";

export interface SessionQueueApi {
  query(sql: string): Promise<Record<string, unknown>[]>;
  ensureSessionsTable(name?: string): Promise<void>;
}

export interface QueuedSessionRow {
  id: string;
  path: string;
  filename: string;
  message: string;
  sessionId: string;
  eventType: string;
  turnIndex: number;
  diaId: string;
  speaker: string;
  text: string;
  turnSummary: string;
  sourceDateTime: string;
  author: string;
  sizeBytes: number;
  project: string;
  description: string;
  agent: string;
  creationDate: string;
  lastUpdateDate: string;
}

export interface FlushSessionQueueOptions {
  sessionId: string;
  sessionsTable: string;
  queueDir?: string;
  maxBatchRows?: number;
  allowStaleInflight?: boolean;
  staleInflightMs?: number;
  waitIfBusyMs?: number;
  drainAll?: boolean;
}

export interface FlushSessionQueueResult {
  status: "empty" | "busy" | "flushed" | "disabled";
  rows: number;
  batches: number;
}

export interface DrainSessionQueueOptions {
  sessionsTable: string;
  queueDir?: string;
  maxBatchRows?: number;
  staleInflightMs?: number;
}

export interface DrainSessionQueueResult {
  queuedSessions: number;
  flushedSessions: number;
  rows: number;
  batches: number;
}

const DEFAULT_QUEUE_DIR = join(homedir(), ".deeplake", "queue");
const DEFAULT_MAX_BATCH_ROWS = 50;
const DEFAULT_STALE_INFLIGHT_MS = 60_000;
const DEFAULT_AUTH_FAILURE_TTL_MS = 5 * 60_000;
const DEFAULT_DRAIN_LOCK_STALE_MS = 30_000;
const BUSY_WAIT_STEP_MS = 100;

interface SessionWriteDisabledState {
  disabledAt: string;
  reason: string;
  sessionsTable: string;
}

class SessionWriteDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionWriteDisabledError";
  }
}

export function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}

export function buildQueuedSessionRow(args: {
  sessionPath: string;
  line: string;
  sessionId?: string;
  userName: string;
  projectName: string;
  description: string;
  agent: string;
  timestamp: string;
}): QueuedSessionRow {
  const structured = extractStructuredSessionFields(args.line, args.sessionId);
  return {
    id: crypto.randomUUID(),
    path: args.sessionPath,
    filename: args.sessionPath.split("/").pop() ?? "",
    message: args.line,
    sessionId: structured.sessionId,
    eventType: structured.eventType,
    turnIndex: structured.turnIndex,
    diaId: structured.diaId,
    speaker: structured.speaker,
    text: structured.text,
    turnSummary: structured.turnSummary,
    sourceDateTime: structured.sourceDateTime,
    author: args.userName,
    sizeBytes: Buffer.byteLength(args.line, "utf-8"),
    project: args.projectName,
    description: args.description,
    agent: args.agent,
    creationDate: args.timestamp,
    lastUpdateDate: args.timestamp,
  };
}

export function appendQueuedSessionRow(row: QueuedSessionRow, queueDir = DEFAULT_QUEUE_DIR): string {
  mkdirSync(queueDir, { recursive: true });
  const sessionId = extractSessionId(row.path);
  const queuePath = getQueuePath(queueDir, sessionId);
  appendFileSync(queuePath, `${JSON.stringify(row)}\n`);
  return queuePath;
}

export function buildSessionInsertSql(sessionsTable: string, rows: QueuedSessionRow[]): string {
  if (rows.length === 0) throw new Error("buildSessionInsertSql: rows must not be empty");
  const table = sqlIdent(sessionsTable);
  const values = rows.map((row) => {
    const jsonForSql = escapeJsonbLiteral(coerceJsonbPayload(row.message));
    return (
      `('${sqlStr(row.id)}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', '${jsonForSql}'::jsonb, ` +
      `'${sqlStr(row.sessionId)}', '${sqlStr(row.eventType)}', ${row.turnIndex}, '${sqlStr(row.diaId)}', ` +
      `'${sqlStr(row.speaker)}', '${sqlStr(row.text)}', '${sqlStr(row.turnSummary)}', '${sqlStr(row.sourceDateTime)}', ` +
      `'${sqlStr(row.author)}', ${row.sizeBytes}, '${sqlStr(row.project)}', '${sqlStr(row.description)}', ` +
      `'${sqlStr(row.agent)}', '${sqlStr(row.creationDate)}', '${sqlStr(row.lastUpdateDate)}')`
    );
  }).join(", ");

  return (
    `INSERT INTO "${table}" ` +
    `(id, path, filename, message, session_id, event_type, turn_index, dia_id, speaker, text, turn_summary, source_date_time, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
    `VALUES ${values}`
  );
}

function coerceJsonbPayload(message: string): string {
  try {
    return JSON.stringify(JSON.parse(message));
  } catch {
    return JSON.stringify({
      type: "raw_message",
      content: message,
    });
  }
}

function escapeJsonbLiteral(value: string): string {
  return value
    .replace(/'/g, "''")
    .replace(/\0/g, "");
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

function extractStructuredSessionFields(message: string, fallbackSessionId = ""): {
  sessionId: string;
  eventType: string;
  turnIndex: number;
  diaId: string;
  speaker: string;
  text: string;
  turnSummary: string;
  sourceDateTime: string;
} {
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(message);
    if (raw && typeof raw === "object") parsed = raw as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      sessionId: fallbackSessionId,
      eventType: "raw_message",
      turnIndex: 0,
      diaId: "",
      speaker: "",
      text: message,
      turnSummary: "",
      sourceDateTime: "",
    };
  }

  const eventType = extractString(parsed["type"]);
  const content = extractString(parsed["content"]);
  const toolName = extractString(parsed["tool_name"]);
  const speaker = extractString(parsed["speaker"])
    || (eventType === "user_message" ? "user" : eventType === "assistant_message" ? "assistant" : "");
  const text = extractString(parsed["text"])
    || content
    || (eventType === "tool_call" ? toolName : "");

  return {
    sessionId: extractString(parsed["session_id"]) || fallbackSessionId,
    eventType,
    turnIndex: extractNumber(parsed["turn_index"]),
    diaId: extractString(parsed["dia_id"]),
    speaker,
    text,
    turnSummary: extractString(parsed["summary"]) || extractString(parsed["message_summary"]) || extractString(parsed["msg_summary"]),
    sourceDateTime: extractString(parsed["source_date_time"]) || extractString(parsed["date_time"]) || extractString(parsed["date"]),
  };
}

export async function flushSessionQueue(api: SessionQueueApi, opts: FlushSessionQueueOptions): Promise<FlushSessionQueueResult> {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  const maxBatchRows = opts.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
  const staleInflightMs = opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS;
  const waitIfBusyMs = opts.waitIfBusyMs ?? 0;
  const drainAll = opts.drainAll ?? false;

  mkdirSync(queueDir, { recursive: true });

  const queuePath = getQueuePath(queueDir, opts.sessionId);
  const inflightPath = getInflightPath(queueDir, opts.sessionId);
  if (isSessionWriteDisabled(opts.sessionsTable, queueDir)) {
    return existsSync(queuePath) || existsSync(inflightPath)
      ? { status: "disabled", rows: 0, batches: 0 }
      : { status: "empty", rows: 0, batches: 0 };
  }
  let totalRows = 0;
  let totalBatches = 0;
  let flushedAny = false;

  while (true) {
    if (opts.allowStaleInflight) recoverStaleInflight(queuePath, inflightPath, staleInflightMs);

    if (existsSync(inflightPath)) {
      if (waitIfBusyMs > 0) {
        await waitForInflightToClear(inflightPath, waitIfBusyMs);
        if (opts.allowStaleInflight) recoverStaleInflight(queuePath, inflightPath, staleInflightMs);
      }
      if (existsSync(inflightPath)) {
        return flushedAny
          ? { status: "flushed", rows: totalRows, batches: totalBatches }
          : { status: "busy", rows: 0, batches: 0 };
      }
    }

    if (!existsSync(queuePath)) {
      return flushedAny
        ? { status: "flushed", rows: totalRows, batches: totalBatches }
        : { status: "empty", rows: 0, batches: 0 };
    }

    try {
      renameSync(queuePath, inflightPath);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        return flushedAny
          ? { status: "flushed", rows: totalRows, batches: totalBatches }
          : { status: "empty", rows: 0, batches: 0 };
      }
      throw e;
    }

    try {
      const { rows, batches } = await flushInflightFile(api, opts.sessionsTable, inflightPath, maxBatchRows);
      totalRows += rows;
      totalBatches += batches;
      flushedAny = flushedAny || rows > 0;
    } catch (e) {
      requeueInflight(queuePath, inflightPath);
      if (e instanceof SessionWriteDisabledError) {
        return { status: "disabled", rows: totalRows, batches: totalBatches };
      }
      throw e;
    }

    if (!drainAll) {
      return { status: "flushed", rows: totalRows, batches: totalBatches };
    }
  }
}

export async function drainSessionQueues(api: SessionQueueApi, opts: DrainSessionQueueOptions): Promise<DrainSessionQueueResult> {
  const queueDir = opts.queueDir ?? DEFAULT_QUEUE_DIR;
  mkdirSync(queueDir, { recursive: true });

  const sessionIds = listQueuedSessionIds(queueDir, opts.staleInflightMs ?? DEFAULT_STALE_INFLIGHT_MS);
  let flushedSessions = 0;
  let rows = 0;
  let batches = 0;

  for (const sessionId of sessionIds) {
    const result = await flushSessionQueue(api, {
      sessionId,
      sessionsTable: opts.sessionsTable,
      queueDir,
      maxBatchRows: opts.maxBatchRows,
      allowStaleInflight: true,
      staleInflightMs: opts.staleInflightMs,
      drainAll: true,
    });
    if (result.status === "flushed") {
      flushedSessions += 1;
      rows += result.rows;
      batches += result.batches;
    }
  }

  return {
    queuedSessions: sessionIds.length,
    flushedSessions,
    rows,
    batches,
  };
}

export function tryAcquireSessionDrainLock(
  sessionsTable: string,
  queueDir = DEFAULT_QUEUE_DIR,
  staleMs = DEFAULT_DRAIN_LOCK_STALE_MS,
): (() => void) | null {
  mkdirSync(queueDir, { recursive: true });
  const lockPath = getSessionDrainLockPath(queueDir, sessionsTable);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (existsSync(lockPath) && isStale(lockPath, staleMs)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      return null;
    }
  }

  return null;
}

function getQueuePath(queueDir: string, sessionId: string): string {
  return join(queueDir, `${sessionId}.jsonl`);
}

function getInflightPath(queueDir: string, sessionId: string): string {
  return join(queueDir, `${sessionId}.inflight`);
}

function extractSessionId(sessionPath: string): string {
  const filename = sessionPath.split("/").pop() ?? "";
  return filename.replace(/\.jsonl$/, "").split("_").pop() ?? filename;
}

async function flushInflightFile(
  api: SessionQueueApi,
  sessionsTable: string,
  inflightPath: string,
  maxBatchRows: number,
): Promise<{ rows: number; batches: number }> {
  const rows = readQueuedRows(inflightPath);
  if (rows.length === 0) {
    rmSync(inflightPath, { force: true });
    return { rows: 0, batches: 0 };
  }

  let ensured = false;
  let batches = 0;
  const queueDir = dirname(inflightPath);
  for (let i = 0; i < rows.length; i += maxBatchRows) {
    const chunk = rows.slice(i, i + maxBatchRows);
    const sql = buildSessionInsertSql(sessionsTable, chunk);
    try {
      await api.query(sql);
    } catch (e: any) {
      if (isSessionWriteAuthError(e)) {
        markSessionWriteDisabled(sessionsTable, errorMessage(e), queueDir);
        throw new SessionWriteDisabledError(errorMessage(e));
      }
      if (!ensured && isEnsureSessionsTableRetryable(e)) {
        try {
          await api.ensureSessionsTable(sessionsTable);
        } catch (ensureError: unknown) {
          if (isSessionWriteAuthError(ensureError)) {
            markSessionWriteDisabled(sessionsTable, errorMessage(ensureError), queueDir);
            throw new SessionWriteDisabledError(errorMessage(ensureError));
          }
          throw ensureError;
        }
        ensured = true;
        try {
          await api.query(sql);
        } catch (retryError: unknown) {
          if (isSessionWriteAuthError(retryError)) {
            markSessionWriteDisabled(sessionsTable, errorMessage(retryError), queueDir);
            throw new SessionWriteDisabledError(errorMessage(retryError));
          }
          throw retryError;
        }
      } else {
        throw e;
      }
    }
    batches += 1;
  }

  clearSessionWriteDisabled(sessionsTable, queueDir);
  rmSync(inflightPath, { force: true });
  return { rows: rows.length, batches };
}

function readQueuedRows(path: string): QueuedSessionRow[] {
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueuedSessionRow);
}

function requeueInflight(queuePath: string, inflightPath: string): void {
  if (!existsSync(inflightPath)) return;
  const inflight = readFileSync(inflightPath, "utf-8");
  appendFileSync(queuePath, inflight);
  rmSync(inflightPath, { force: true });
}

function recoverStaleInflight(queuePath: string, inflightPath: string, staleInflightMs: number): void {
  if (!existsSync(inflightPath) || !isStale(inflightPath, staleInflightMs)) return;
  requeueInflight(queuePath, inflightPath);
}

function isStale(path: string, staleInflightMs: number): boolean {
  return Date.now() - statSync(path).mtimeMs >= staleInflightMs;
}

function listQueuedSessionIds(queueDir: string, staleInflightMs: number): string[] {
  const sessionIds = new Set<string>();
  for (const name of readdirSync(queueDir)) {
    if (name.endsWith(".jsonl")) {
      sessionIds.add(name.slice(0, -".jsonl".length));
    } else if (name.endsWith(".inflight")) {
      const path = join(queueDir, name);
      if (isStale(path, staleInflightMs)) {
        sessionIds.add(name.slice(0, -".inflight".length));
      }
    }
  }
  return [...sessionIds].sort();
}

function isEnsureSessionsTableRetryable(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("does not exist") ||
    message.includes("doesn't exist") ||
    message.includes("relation") ||
    message.includes("not found");
}

export function isSessionWriteAuthError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("403") ||
    message.includes("401") ||
    message.includes("forbidden") ||
    message.includes("unauthorized");
}

export function markSessionWriteDisabled(
  sessionsTable: string,
  reason: string,
  queueDir = DEFAULT_QUEUE_DIR,
): void {
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(
    getSessionWriteDisabledPath(queueDir, sessionsTable),
    JSON.stringify({
      disabledAt: new Date().toISOString(),
      reason,
      sessionsTable,
    } satisfies SessionWriteDisabledState),
  );
}

export function clearSessionWriteDisabled(
  sessionsTable: string,
  queueDir = DEFAULT_QUEUE_DIR,
): void {
  rmSync(getSessionWriteDisabledPath(queueDir, sessionsTable), { force: true });
}

export function isSessionWriteDisabled(
  sessionsTable: string,
  queueDir = DEFAULT_QUEUE_DIR,
  ttlMs = DEFAULT_AUTH_FAILURE_TTL_MS,
): boolean {
  const path = getSessionWriteDisabledPath(queueDir, sessionsTable);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    const state = JSON.parse(raw) as SessionWriteDisabledState;
    const ageMs = Date.now() - new Date(state.disabledAt).getTime();
    if (Number.isNaN(ageMs) || ageMs >= ttlMs) {
      rmSync(path, { force: true });
      return false;
    }
    return true;
  } catch {
    rmSync(path, { force: true });
    return false;
  }
}

function getSessionWriteDisabledPath(queueDir: string, sessionsTable: string): string {
  return join(queueDir, `.${sessionsTable}.disabled.json`);
}

function getSessionDrainLockPath(queueDir: string, sessionsTable: string): string {
  return join(queueDir, `.${sessionsTable}.drain.lock`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForInflightToClear(inflightPath: string, waitIfBusyMs: number): Promise<void> {
  const startedAt = Date.now();
  while (existsSync(inflightPath) && (Date.now() - startedAt) < waitIfBusyMs) {
    await sleep(BUSY_WAIT_STEP_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
