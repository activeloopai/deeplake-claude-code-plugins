import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Direct source-level tests for src/hooks/wiki-worker.ts. The module
 * reads its config JSON from process.argv[2] at module load, then
 * runs main() immediately. Each scenario writes a fresh config file
 * under a tmp dir, points process.argv[2] at it, wires the mocks, and
 * dynamically imports the worker.
 *
 * Mocks:
 *   - global.fetch (the query() helper)
 *   - child_process.execFileSync (the claude -p invocation)
 *   - summary-state (finalizeSummary + releaseLock)
 *   - upload-summary (uploadSummary)
 *
 * fs stays real: the worker writes the reconstructed JSONL and the
 * summary markdown to the tmp dir, and main() reads the summary back
 * after claude -p has "written" it. The execFileSync mock simulates
 * claude by writing the summary file directly, which is how the real
 * binary behaves from the worker's perspective.
 */

const finalizeSummaryMock = vi.fn();
const releaseLockMock = vi.fn();
const uploadSummaryMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock("../../src/hooks/summary-state.js", () => ({
  finalizeSummary: (...a: any[]) => finalizeSummaryMock(...a),
  releaseLock: (...a: any[]) => releaseLockMock(...a),
}));
vi.mock("../../src/hooks/upload-summary.js", () => ({
  uploadSummary: (...a: any[]) => uploadSummaryMock(...a),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...a: any[]) => execFileSyncMock(...a) };
});

const originalFetch = global.fetch;
const fetchMock = vi.fn();

const originalArgv2 = process.argv[2];

let rootDir: string;  // shared parent — NOT removed by the worker
let tmpDir: string;   // worker's tmpDir, rmSync'd in cleanup()
let hooksDir: string; // wiki.log lives here; must outlive tmpDir
let configPath: string;

const defaultConfig = () => ({
  apiUrl: "http://fake.local",
  token: "tok",
  orgId: "org",
  workspaceId: "default",
  memoryTable: "memory",
  sessionsTable: "sessions",
  sessionId: "sid-worker",
  userName: "alice",
  project: "proj",
  tmpDir,
  claudeBin: "/fake/claude",
  wikiLog: join(hooksDir, "wiki.log"),
  hooksDir,
  promptTemplate: "JSONL=__JSONL__ SUMMARY=__SUMMARY__ SID=__SESSION_ID__ PROJ=__PROJECT__ OFFSET=__PREV_OFFSET__ LINES=__JSONL_LINES__ SRC=__JSONL_SERVER_PATH__",
});

function writeConfig(overrides: Partial<ReturnType<typeof defaultConfig>> = {}): void {
  const cfg = { ...defaultConfig(), ...overrides };
  writeFileSync(configPath, JSON.stringify(cfg));
}

function jsonResp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

async function runWorker(): Promise<void> {
  vi.resetModules();
  // @ts-expect-error
  global.fetch = fetchMock;
  await import("../../src/hooks/wiki-worker.js");
  // Let main() and all its awaits complete.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "wiki-worker-test-"));
  tmpDir = join(rootDir, "tmp");
  hooksDir = join(rootDir, "hooks");
  // The worker will mkdir hooksDir lazily via wlog, but it needs tmpDir
  // to exist for writeFileSync(tmpJsonl, ...).
  require("node:fs").mkdirSync(tmpDir, { recursive: true });
  require("node:fs").mkdirSync(hooksDir, { recursive: true });
  configPath = join(rootDir, "config.json");
  writeConfig();
  process.argv[2] = configPath;
  fetchMock.mockReset();
  finalizeSummaryMock.mockReset();
  releaseLockMock.mockReset();
  uploadSummaryMock.mockReset().mockResolvedValue({ path: "insert", summaryLength: 100, descLength: 20, sql: "..." });
  execFileSyncMock.mockReset();
});

afterEach(() => {
  // @ts-expect-error
  global.fetch = originalFetch;
  process.argv[2] = originalArgv2;
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ═══ early exit: zero events ═══════════════════════════════════════════════

describe("wiki-worker — no events", () => {
  it("exits early when the sessions table has no rows for this session", async () => {
    fetchMock.mockResolvedValue(jsonResp({ columns: ["message", "creation_date"], rows: [] }));
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("no session events found — exiting");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(finalizeSummaryMock).not.toHaveBeenCalled();
    // The finally block must still release the lock.
    expect(releaseLockMock).toHaveBeenCalledWith("sid-worker");
  });

  it("treats a response with null rows/columns as empty", async () => {
    fetchMock.mockResolvedValue(jsonResp({}));
    await runWorker();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
  });
});

// ═══ happy path: events + claude -p + upload ═══════════════════════════════

describe("wiki-worker — happy path", () => {
  const eventRows = [
    { message: JSON.stringify({ type: "user_message", content: "hi" }), creation_date: "2026-04-20T00:00:00Z" },
    { message: JSON.stringify({ type: "assistant_message", content: "hello" }), creation_date: "2026-04-20T00:00:01Z" },
  ];

  const mkFetch = (eventsCol: string[] = ["message", "creation_date"], pathRows = 1, hasSummary = false) => {
    let call = 0;
    return fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message, creation_date")) {
        return jsonResp({ columns: eventsCol, rows: eventRows.map(r => [r.message, r.creation_date]) });
      }
      if (sql.startsWith("SELECT DISTINCT path")) {
        return jsonResp({
          columns: ["path"],
          rows: pathRows > 0 ? [["/sessions/alice/alice_org_default_sid-worker.jsonl"]] : [],
        });
      }
      if (sql.startsWith("SELECT summary FROM")) {
        if (hasSummary) {
          return jsonResp({ columns: ["summary"], rows: [["# Session X\n- **JSONL offset**: 12\n\n## What Happened\nprior"]] });
        }
        return jsonResp({ columns: ["summary"], rows: [] });
      }
      call++;
      throw new Error(`unexpected query (${call}): ${sql}`);
    });
  };

  it("fetches events, writes JSONL, runs claude -p, uploads, finalizes, releases", async () => {
    mkFetch();
    let capturedJsonl: string | null = null;
    // Simulate claude -p producing a summary file. We also snapshot the
    // reconstructed JSONL here because cleanup() will rmSync tmpDir
    // before the test can read it back from disk.
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const promptIdx = args.indexOf("-p") + 1;
      const prompt = args[promptIdx];
      const jsonlPath = prompt.match(/JSONL=(\S+)/)![1];
      capturedJsonl = readFileSync(jsonlPath, "utf-8");
      const summaryPath = prompt.match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# Session sid-worker\n\n## What Happened\nStuff happened.\n");
      return Buffer.from("");
    });
    await runWorker();

    // JSONL was written with the two events joined (captured before cleanup)
    expect(capturedJsonl).not.toBeNull();
    expect(capturedJsonl!.split("\n")).toHaveLength(2);

    // claude -p was called with the prompt template expanded
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const calledArgs = execFileSyncMock.mock.calls[0][1] as string[];
    expect(calledArgs[0]).toBe("-p");
    expect(calledArgs).toContain("--no-session-persistence");
    expect(calledArgs).toContain("--model");
    expect(calledArgs).toContain("haiku");
    expect(calledArgs).toContain("--permission-mode");
    expect(calledArgs).toContain("bypassPermissions");

    // Prompt template was expanded with real values
    const prompt = calledArgs[1];
    expect(prompt).toContain("SID=sid-worker");
    expect(prompt).toContain("PROJ=proj");
    expect(prompt).toContain("LINES=2");
    expect(prompt).toContain("OFFSET=0");
    expect(prompt).toContain("SRC=/sessions/alice/alice_org_default_sid-worker.jsonl");

    // env flags on execFileSync to prevent runaway recursion
    const execOpts = execFileSyncMock.mock.calls[0][2];
    expect(execOpts.env.HIVEMIND_WIKI_WORKER).toBe("1");
    expect(execOpts.env.HIVEMIND_CAPTURE).toBe("false");

    // upload was called with the full summary
    expect(uploadSummaryMock).toHaveBeenCalledTimes(1);
    const uploadParams = uploadSummaryMock.mock.calls[0][1];
    expect(uploadParams.tableName).toBe("memory");
    expect(uploadParams.agent).toBe("claude_code");
    expect(uploadParams.text).toContain("## What Happened");

    // finalize + release
    expect(finalizeSummaryMock).toHaveBeenCalledWith("sid-worker", 2);
    expect(releaseLockMock).toHaveBeenCalledWith("sid-worker");
  });

  it("parses JSONL offset from an existing summary on a resumed session", async () => {
    mkFetch(undefined, 1, true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[1].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# Session sid-worker\n\n## What Happened\ndone.\n");
      return Buffer.from("");
    });
    await runWorker();
    const prompt = execFileSyncMock.mock.calls[0][1][1] as string;
    expect(prompt).toContain("OFFSET=12");
    // tmpSummary was pre-seeded with the existing summary so claude -p
    // can merge on top. Verify the worker did write it.
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("existing summary found, offset=12");
  });

  it("defaults to /sessions/unknown/ when the path SELECT returns no rows", async () => {
    mkFetch(undefined, 0);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[1].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# Session\n\n## What Happened\nfallback.\n");
      return Buffer.from("");
    });
    await runWorker();
    const prompt = execFileSyncMock.mock.calls[0][1][1] as string;
    expect(prompt).toContain("SRC=/sessions/unknown/sid-worker.jsonl");
  });

  it("serializes event rows that arrive as objects (JSONB) instead of strings", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message, creation_date")) {
        return jsonResp({
          columns: ["message", "creation_date"],
          rows: [
            [{ type: "user_message", content: "hi" }, "2026-04-20T00:00:00Z"],
            [{ type: "tool_call", tool_name: "Bash" }, "2026-04-20T00:00:01Z"],
          ],
        });
      }
      if (sql.startsWith("SELECT DISTINCT path")) {
        return jsonResp({ columns: ["path"], rows: [["/sessions/alice/x.jsonl"]] });
      }
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    let capturedJsonl: string | null = null;
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const jsonlPath = args[1].match(/JSONL=(\S+)/)![1];
      capturedJsonl = readFileSync(jsonlPath, "utf-8");
      const summaryPath = args[1].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "x");
      return Buffer.from("");
    });
    await runWorker();
    expect(capturedJsonl).toContain('"type":"user_message"');
    expect(capturedJsonl).toContain('"type":"tool_call"');
  });
});

// ═══ claude -p failure paths ═══════════════════════════════════════════════

describe("wiki-worker — claude -p failure", () => {
  it("logs the claude exit code and skips the upload when no summary file lands", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message")) return jsonResp({ columns: ["message", "creation_date"], rows: [["{}", "t"]] });
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/sessions/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    const err: any = new Error("claude boom");
    err.status = 42;
    execFileSyncMock.mockImplementation(() => { throw err; });
    await runWorker();

    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("claude -p failed: 42");
    expect(log).toContain("no summary file generated");
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(finalizeSummaryMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("falls back to err.message when err.status is absent", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message")) return jsonResp({ columns: ["message", "creation_date"], rows: [["{}", "t"]] });
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    execFileSyncMock.mockImplementation(() => { throw new Error("no status"); });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("claude -p failed: no status");
  });
});

// ═══ query retry logic ═════════════════════════════════════════════════════

describe("wiki-worker — query retry logic", () => {
  beforeEach(() => {
    // Stub setTimeout so retries don't actually sleep.
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: any) => {
      cb();
      return 0 as any;
    }) as any);
  });

  it("retries on 500 and eventually succeeds", async () => {
    const responses = [
      jsonResp("server error", false, 500),
      jsonResp("server error", false, 500),
      jsonResp({ columns: ["message", "creation_date"], rows: [] }),
    ];
    fetchMock.mockImplementation(async () => responses.shift()!);
    await runWorker();
    // First query to sessions table was retried 2 times before success.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("retries on 401/403/429/502/503 (CloudFlare rate-limit class)", async () => {
    for (const status of [401, 403, 429, 502, 503]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResp("", false, status))
        .mockResolvedValue(jsonResp({ columns: ["message", "creation_date"], rows: [] }));
      await runWorker();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("throws (and main catches) on a non-retryable 400", async () => {
    fetchMock.mockResolvedValue(jsonResp("bad request", false, 400));
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toMatch(/fatal: API 400/);
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("gives up after exhausting retries on persistent 500", async () => {
    fetchMock.mockResolvedValue(jsonResp("still down", false, 500));
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toMatch(/fatal: API 500/);
  });
});

// ═══ finalize + release edge cases ═════════════════════════════════════════

describe("wiki-worker — finalize + release edge cases", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message")) return jsonResp({ columns: ["message", "creation_date"], rows: [["{}", "t"]] });
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[1].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# s\n## What Happened\nX\n");
      return Buffer.from("");
    });
  });

  it("logs sidecar update failure but still releases the lock", async () => {
    finalizeSummaryMock.mockImplementation(() => { throw new Error("sidecar boom"); });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("sidecar update failed: sidecar boom");
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("keeps going when releaseLock throws — the finally swallows it", async () => {
    releaseLockMock.mockImplementation(() => { throw new Error("release boom"); });
    await runWorker();
    // Worker still completes; the failure is caught in the finally.
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("done");
  });

  it("does not upload when the summary file is present but empty", async () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[1].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "   \n");
      return Buffer.from("");
    });
    await runWorker();
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(finalizeSummaryMock).not.toHaveBeenCalled();
  });
});
