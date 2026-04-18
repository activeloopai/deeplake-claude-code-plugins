import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendQueuedSessionRow,
  buildQueuedSessionRow,
  buildSessionInsertSql,
  buildSessionPath,
  clearSessionWriteDisabled,
  drainSessionQueues,
  flushSessionQueue,
  isSessionWriteDisabled,
  markSessionWriteDisabled,
  type QueuedSessionRow,
  type SessionQueueApi,
} from "../../src/hooks/session-queue.js";

const tempDirs: string[] = [];

function makeQueueDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hivemind-session-queue-"));
  tempDirs.push(dir);
  return dir;
}

function makeRow(sessionId: string, seq: number, overrides: Partial<QueuedSessionRow> = {}): QueuedSessionRow {
  const sessionPath = buildSessionPath(
    { userName: "alice", orgName: "acme", workspaceId: "default" },
    sessionId,
  );
  const timestamp = `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}Z`;
  const line = JSON.stringify({
    id: `event-${seq}`,
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    timestamp,
    type: "tool_call",
    tool_name: "Read",
    content: `row-${seq}`,
  });

  return {
    ...buildQueuedSessionRow({
      sessionPath,
      line,
      userName: "alice",
      projectName: "repo",
      description: "PostToolUse",
      agent: "claude_code",
      timestamp,
    }),
    ...overrides,
  };
}

function makeApi(queryImpl?: (sql: string) => Promise<Record<string, unknown>[]>) {
  const api: SessionQueueApi & {
    query: ReturnType<typeof vi.fn>;
    ensureSessionsTable: ReturnType<typeof vi.fn>;
  } = {
    query: vi.fn(queryImpl ?? (async () => [])),
    ensureSessionsTable: vi.fn(async () => undefined),
  };
  return api;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("session queue", () => {
  it("appends one JSONL line per queued row", () => {
    const queueDir = makeQueueDir();
    const row = makeRow("session-append", 1);

    const queuePath = appendQueuedSessionRow(row, queueDir);
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(row);
  });

  it("builds a multi-row INSERT that preserves JSONB payloads", () => {
    const row1 = makeRow("session-sql", 1, {
      message: JSON.stringify({ content: "it's", path: "C:\\Users\\alice\\file.ts" }),
    });
    const row2 = makeRow("session-sql", 2);

    const sql = buildSessionInsertSql("sessions", [row1, row2]);

    expect(sql.match(/::jsonb/g)).toHaveLength(2);
    expect(sql).toContain("it''s");
    expect(sql).toContain('"path":"C:');
    expect(sql).toContain("file.ts");
    expect(sql).toContain("), (");
  });

  it("wraps malformed messages in a valid JSON object before casting to jsonb", () => {
    const row = makeRow("session-sql-fallback", 1, {
      message: "{not-json",
    });

    const sql = buildSessionInsertSql("sessions", [row]);

    expect(sql).toContain(`"type":"raw_message"`);
    expect(sql).toContain(`"content":"{not-json"`);
    expect(sql).toContain("::jsonb");
  });

  it("returns empty when there is nothing to flush", async () => {
    const queueDir = makeQueueDir();
    const api = makeApi();

    const result = await flushSessionQueue(api, {
      sessionId: "session-empty",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "empty", rows: 0, batches: 0 });
    expect(api.query).not.toHaveBeenCalled();
  });

  it("flushes a queue in chunked multi-row INSERT batches", async () => {
    const queueDir = makeQueueDir();
    const api = makeApi();

    for (let i = 0; i < 51; i++) {
      appendQueuedSessionRow(makeRow("session-batch", i), queueDir);
    }

    const result = await flushSessionQueue(api, {
      sessionId: "session-batch",
      sessionsTable: "sessions",
      queueDir,
      maxBatchRows: 50,
      drainAll: true,
    });

    expect(result).toEqual({ status: "flushed", rows: 51, batches: 2 });
    expect(api.query).toHaveBeenCalledTimes(2);
    expect(api.ensureSessionsTable).not.toHaveBeenCalled();
    expect(existsSync(join(queueDir, "session-batch.jsonl"))).toBe(false);
    expect(existsSync(join(queueDir, "session-batch.inflight"))).toBe(false);
  });

  it("retries once after ensuring the sessions table", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-retry", 1), queueDir);

    let attempts = 0;
    const api = makeApi(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("table sessions does not exist");
      return [];
    });

    const result = await flushSessionQueue(api, {
      sessionId: "session-retry",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "flushed", rows: 1, batches: 1 });
    expect(api.ensureSessionsTable).toHaveBeenCalledWith("sessions");
    expect(api.query).toHaveBeenCalledTimes(2);
  });

  it("removes empty queue files without issuing inserts", async () => {
    const queueDir = makeQueueDir();
    writeFileSync(join(queueDir, "session-empty-file.jsonl"), "");

    const api = makeApi();
    const result = await flushSessionQueue(api, {
      sessionId: "session-empty-file",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "flushed", rows: 0, batches: 0 });
    expect(api.query).not.toHaveBeenCalled();
    expect(existsSync(join(queueDir, "session-empty-file.inflight"))).toBe(false);
  });

  it("rethrows non-auth ensureSessionsTable failures", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-ensure-error", 1), queueDir);

    const api = makeApi(async () => {
      throw new Error("table sessions does not exist");
    });
    api.ensureSessionsTable.mockRejectedValueOnce(new Error("dial tcp reset"));

    await expect(flushSessionQueue(api, {
      sessionId: "session-ensure-error",
      sessionsTable: "sessions",
      queueDir,
    })).rejects.toThrow("dial tcp reset");
  });

  it("rethrows non-auth retry failures after ensureSessionsTable succeeds", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-retry-error", 1), queueDir);

    let attempts = 0;
    const api = makeApi(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("table sessions does not exist");
      throw new Error("network blew up");
    });

    await expect(flushSessionQueue(api, {
      sessionId: "session-retry-error",
      sessionsTable: "sessions",
      queueDir,
    })).rejects.toThrow("network blew up");
    expect(api.ensureSessionsTable).toHaveBeenCalledWith("sessions");
  });

  it("re-queues failed inflight rows back into the queue", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-fail", 1), queueDir);

    const api = makeApi(async () => {
      appendQueuedSessionRow(makeRow("session-fail", 2), queueDir);
      throw new Error("network blew up");
    });

    await expect(flushSessionQueue(api, {
      sessionId: "session-fail",
      sessionsTable: "sessions",
      queueDir,
    })).rejects.toThrow("network blew up");

    const lines = readFileSync(join(queueDir, "session-fail.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const messages = lines.map((line) => JSON.parse(line).message);
    expect(messages.some((m: string) => m.includes("row-1"))).toBe(true);
    expect(messages.some((m: string) => m.includes("row-2"))).toBe(true);
    expect(existsSync(join(queueDir, "session-fail.inflight"))).toBe(false);
  });

  it("returns busy while another flusher owns the inflight file", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-busy", 1), queueDir);
    renameSync(
      join(queueDir, "session-busy.jsonl"),
      join(queueDir, "session-busy.inflight"),
    );
    appendQueuedSessionRow(makeRow("session-busy", 2), queueDir);

    const api = makeApi();
    const result = await flushSessionQueue(api, {
      sessionId: "session-busy",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "busy", rows: 0, batches: 0 });
    expect(api.query).not.toHaveBeenCalled();
  });

  it("waits for inflight ownership to clear before flushing queued rows", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-wait", 1), queueDir);
    renameSync(
      join(queueDir, "session-wait.jsonl"),
      join(queueDir, "session-wait.inflight"),
    );
    appendQueuedSessionRow(makeRow("session-wait", 2), queueDir);

    setTimeout(() => {
      rmSync(join(queueDir, "session-wait.inflight"), { force: true });
    }, 50);

    const api = makeApi();
    const result = await flushSessionQueue(api, {
      sessionId: "session-wait",
      sessionsTable: "sessions",
      queueDir,
      waitIfBusyMs: 250,
    });

    expect(result).toEqual({ status: "flushed", rows: 1, batches: 1 });
    expect(api.query).toHaveBeenCalledTimes(1);
    expect((api.query.mock.calls[0]?.[0] as string) ?? "").toContain("row-2");
  });

  it("drains stale inflight files on session start replay", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-stale", 1), queueDir);
    renameSync(
      join(queueDir, "session-stale.jsonl"),
      join(queueDir, "session-stale.inflight"),
    );
    utimesSync(join(queueDir, "session-stale.inflight"), 0, 0);

    const api = makeApi();
    const result = await drainSessionQueues(api, {
      sessionsTable: "sessions",
      queueDir,
      staleInflightMs: 1,
    });

    expect(result).toEqual({
      queuedSessions: 1,
      flushedSessions: 1,
      rows: 1,
      batches: 1,
    });
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(existsSync(join(queueDir, "session-stale.inflight"))).toBe(false);
  });

  it("drains queued .jsonl sessions on session start replay", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-drain-queued", 1), queueDir);

    const api = makeApi();
    const result = await drainSessionQueues(api, {
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({
      queuedSessions: 1,
      flushedSessions: 1,
      rows: 1,
      batches: 1,
    });
  });

  it("marks session writes disabled on auth failures and preserves the queue", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-auth", 1), queueDir);

    const api = makeApi(async () => {
      throw new Error("Query failed: 403: Forbidden");
    });

    const result = await flushSessionQueue(api, {
      sessionId: "session-auth",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "disabled", rows: 0, batches: 0 });
    expect(api.ensureSessionsTable).not.toHaveBeenCalled();
    expect(isSessionWriteDisabled("sessions", queueDir)).toBe(true);
    expect(existsSync(join(queueDir, "session-auth.jsonl"))).toBe(true);
  });

  it("skips flush attempts while session writes are locally disabled", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-skip", 1), queueDir);

    const api = makeApi();
    const first = await flushSessionQueue(api, {
      sessionId: "session-skip",
      sessionsTable: "sessions",
      queueDir,
    });
    expect(first.status).toBe("flushed");

    appendQueuedSessionRow(makeRow("session-skip", 2), queueDir);
    const failingApi = makeApi(async () => {
      throw new Error("403 Forbidden");
    });
    const disabled = await flushSessionQueue(failingApi, {
      sessionId: "session-skip",
      sessionsTable: "sessions",
      queueDir,
    });
    expect(disabled.status).toBe("disabled");

    const skipped = await flushSessionQueue(api, {
      sessionId: "session-skip",
      sessionsTable: "sessions",
      queueDir,
    });
    expect(skipped).toEqual({ status: "disabled", rows: 0, batches: 0 });
    expect(api.query).toHaveBeenCalledTimes(1);

    clearSessionWriteDisabled("sessions", queueDir);
  });

  it("returns empty when writes are disabled but no queue files remain", async () => {
    const queueDir = makeQueueDir();
    markSessionWriteDisabled("sessions", "403 Forbidden", queueDir);

    const result = await flushSessionQueue(makeApi(), {
      sessionId: "session-disabled-empty",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "empty", rows: 0, batches: 0 });
  });

  it("recovers stale inflight files during a direct flush when allowed", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-recover", 1), queueDir);
    renameSync(
      join(queueDir, "session-recover.jsonl"),
      join(queueDir, "session-recover.inflight"),
    );
    utimesSync(join(queueDir, "session-recover.inflight"), 0, 0);

    const api = makeApi();
    const result = await flushSessionQueue(api, {
      sessionId: "session-recover",
      sessionsTable: "sessions",
      queueDir,
      allowStaleInflight: true,
      staleInflightMs: 1,
    });

    expect(result).toEqual({ status: "flushed", rows: 1, batches: 1 });
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("removes expired and malformed disabled markers", () => {
    const queueDir = makeQueueDir();
    markSessionWriteDisabled("sessions", "403 Forbidden", queueDir);

    expect(isSessionWriteDisabled("sessions", queueDir, 0)).toBe(false);

    const disabledPath = join(queueDir, ".sessions.disabled.json");
    writeFileSync(disabledPath, "{not-json");
    expect(isSessionWriteDisabled("sessions", queueDir)).toBe(false);
    expect(existsSync(disabledPath)).toBe(false);
  });

  it("marks writes disabled when ensureSessionsTable fails with auth", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-ensure-auth", 1), queueDir);

    const api = makeApi(async () => {
      throw new Error("table sessions does not exist");
    });
    api.ensureSessionsTable.mockRejectedValueOnce(new Error("403 Forbidden"));

    const result = await flushSessionQueue(api, {
      sessionId: "session-ensure-auth",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "disabled", rows: 0, batches: 0 });
    expect(isSessionWriteDisabled("sessions", queueDir)).toBe(true);
  });

  it("marks writes disabled when the retry after ensure fails with auth", async () => {
    const queueDir = makeQueueDir();
    appendQueuedSessionRow(makeRow("session-retry-auth", 1), queueDir);

    let attempts = 0;
    const api = makeApi(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("table sessions does not exist");
      throw new Error("401 Unauthorized");
    });

    const result = await flushSessionQueue(api, {
      sessionId: "session-retry-auth",
      sessionsTable: "sessions",
      queueDir,
    });

    expect(result).toEqual({ status: "disabled", rows: 0, batches: 0 });
    expect(api.ensureSessionsTable).toHaveBeenCalledWith("sessions");
    expect(isSessionWriteDisabled("sessions", queueDir)).toBe(true);
  });
});
