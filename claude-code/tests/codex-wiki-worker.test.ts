import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Source-level tests for src/hooks/codex/wiki-worker.ts. Mirrors the
 * CC wiki-worker test: mock fetch + execFileSync + summary-state +
 * upload-summary, feed a config file via process.argv[2], drive the
 * module through every branch.
 *
 * Codex-specific differences vs the CC worker:
 *   - binary key is `codexBin` (not `claudeBin`)
 *   - invoked as `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
 *   - agent label on upload is `"codex"` (not `"claude_code"`)
 */

const finalizeSummaryMock = vi.fn();
const releaseLockMock = vi.fn();
const uploadSummaryMock = vi.fn();
const execFileSyncMock = vi.fn();
const embedSummaryMock = vi.fn();

vi.mock("../../src/hooks/summary-state.js", () => ({
  finalizeSummary: (...a: any[]) => finalizeSummaryMock(...a),
  releaseLock: (...a: any[]) => releaseLockMock(...a),
}));
vi.mock("../../src/hooks/upload-summary.js", () => ({
  uploadSummary: (...a: any[]) => uploadSummaryMock(...a),
}));
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    async embed(text: string, kind: string) { return embedSummaryMock(text, kind); }
  },
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...a: any[]) => execFileSyncMock(...a) };
});

const originalFetch = global.fetch;
const fetchMock = vi.fn();
const originalArgv2 = process.argv[2];

let rootDir: string;
let tmpDir: string;
let hooksDir: string;
let configPath: string;

const defaultConfig = () => ({
  apiUrl: "http://fake.local",
  token: "tok",
  orgId: "org",
  workspaceId: "default",
  memoryTable: "memory",
  sessionsTable: "sessions",
  sessionId: "sid-codex",
  userName: "alice",
  project: "proj",
  tmpDir,
  codexBin: "/fake/codex",
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
    ok, status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

async function runWorker(): Promise<void> {
  vi.resetModules();
  // @ts-expect-error
  global.fetch = fetchMock;
  await import("../../src/hooks/codex/wiki-worker.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "codex-wiki-worker-test-"));
  tmpDir = join(rootDir, "tmp");
  hooksDir = join(rootDir, "hooks");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  configPath = join(rootDir, "config.json");
  writeConfig();
  process.argv[2] = configPath;
  fetchMock.mockReset();
  finalizeSummaryMock.mockReset();
  releaseLockMock.mockReset();
  uploadSummaryMock.mockReset().mockResolvedValue({ path: "insert", summaryLength: 80, descLength: 15, sql: "..." });
  embedSummaryMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  execFileSyncMock.mockReset();
});

afterEach(() => {
  // @ts-expect-error
  global.fetch = originalFetch;
  process.argv[2] = originalArgv2;
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ═══ early exit ═════════════════════════════════════════════════════════════

describe("codex wiki-worker — no events", () => {
  it("exits early when the sessions table has no rows for this session", async () => {
    fetchMock.mockResolvedValue(jsonResp({ columns: ["message", "creation_date"], rows: [] }));
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("no session events found — exiting");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalledWith("sid-codex");
  });

  it("handles a response with null rows as empty", async () => {
    fetchMock.mockResolvedValue(jsonResp({}));
    await runWorker();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

// ═══ happy path ═════════════════════════════════════════════════════════════

describe("codex wiki-worker — happy path", () => {
  const eventRow = [
    { message: JSON.stringify({ type: "user_message", content: "hello codex" }), creation_date: "2026-04-20T00:00:00Z" },
  ];

  const mkFetch = (pathRows = 1, hasSummary = false) => {
    return fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message, creation_date")) {
        return jsonResp({ columns: ["message", "creation_date"], rows: eventRow.map(r => [r.message, r.creation_date]) });
      }
      if (sql.startsWith("SELECT DISTINCT path")) {
        return jsonResp({
          columns: ["path"],
          rows: pathRows > 0 ? [["/sessions/alice/alice_org_default_sid-codex.jsonl"]] : [],
        });
      }
      if (sql.startsWith("SELECT summary FROM")) {
        if (hasSummary) {
          return jsonResp({ columns: ["summary"], rows: [["# Session X\n- **JSONL offset**: 7\n\n## What Happened\nprior"]] });
        }
        return jsonResp({ columns: ["summary"], rows: [] });
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  };

  it("runs `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>` and uploads summary", async () => {
    mkFetch();
    let capturedJsonl: string | null = null;
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      expect(bin).toBe("/fake/codex");
      expect(args[0]).toBe("exec");
      expect(args[1]).toBe("--dangerously-bypass-approvals-and-sandbox");
      const prompt = args[2];
      const jsonlPath = prompt.match(/JSONL=(\S+)/)![1];
      capturedJsonl = readFileSync(jsonlPath, "utf-8");
      const summaryPath = prompt.match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# Session sid-codex\n\n## What Happened\ndone.\n");
      return Buffer.from("");
    });
    await runWorker();

    expect(capturedJsonl).toContain('"type":"user_message"');
    expect(capturedJsonl).toContain('"content":"hello codex"');

    // codex exec is invoked with HIVEMIND_WIKI_WORKER=1 to prevent the
    // child's own capture hook from recursing back into this worker.
    const execOpts = execFileSyncMock.mock.calls[0][2];
    expect(execOpts.env.HIVEMIND_WIKI_WORKER).toBe("1");
    expect(execOpts.env.HIVEMIND_CAPTURE).toBe("false");

    // Upload agent is 'codex' (not 'claude_code')
    expect(uploadSummaryMock).toHaveBeenCalledTimes(1);
    const params = uploadSummaryMock.mock.calls[0][1];
    expect(params.agent).toBe("codex");
    expect(params.sessionId).toBe("sid-codex");

    expect(finalizeSummaryMock).toHaveBeenCalledWith("sid-codex", 1);
    expect(releaseLockMock).toHaveBeenCalledWith("sid-codex");
  });

  it("parses JSONL offset from an existing summary on resumed session", async () => {
    mkFetch(1, true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const prompt = args[2];
      const summaryPath = prompt.match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# updated\n\n## What Happened\n...\n");
      return Buffer.from("");
    });
    await runWorker();
    const prompt = execFileSyncMock.mock.calls[0][1][2] as string;
    expect(prompt).toContain("OFFSET=7");
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("existing summary found, offset=7");
  });

  it("falls back to /sessions/unknown/ when path SELECT empty", async () => {
    mkFetch(0);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[2].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "x\n");
      return Buffer.from("");
    });
    await runWorker();
    const prompt = execFileSyncMock.mock.calls[0][1][2] as string;
    expect(prompt).toContain("SRC=/sessions/unknown/sid-codex.jsonl");
  });

  it("serializes JSONB object rows by stringifying them", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message, creation_date")) {
        return jsonResp({
          columns: ["message", "creation_date"],
          rows: [[{ type: "user_message", content: "obj" }, "t"]],
        });
      }
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    let capturedJsonl: string | null = null;
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const jsonlPath = args[2].match(/JSONL=(\S+)/)![1];
      capturedJsonl = readFileSync(jsonlPath, "utf-8");
      const summaryPath = args[2].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "x");
      return Buffer.from("");
    });
    await runWorker();
    expect(capturedJsonl).toContain('"type":"user_message"');
  });
});

// ═══ codex exec failure ════════════════════════════════════════════════════

describe("codex wiki-worker — codex exec failure", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message")) return jsonResp({ columns: ["message", "creation_date"], rows: [["{}", "t"]] });
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
  });

  it("logs status and skips upload when codex exec throws without producing a summary", async () => {
    const err: any = new Error("codex crashed");
    err.status = 99;
    execFileSyncMock.mockImplementation(() => { throw err; });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("codex exec failed: 99");
    expect(log).toContain("no summary file generated");
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("falls back to err.message when err.status is absent", async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("no status here"); });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("codex exec failed: no status here");
  });
});

// ═══ query retry logic ═════════════════════════════════════════════════════

describe("codex wiki-worker — query retry logic", () => {
  beforeEach(() => {
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: any) => {
      cb();
      return 0 as any;
    }) as any);
  });

  it("retries on 500 until success", async () => {
    const responses = [
      jsonResp("server error", false, 500),
      jsonResp({ columns: ["message", "creation_date"], rows: [] }),
    ];
    fetchMock.mockImplementation(async () => responses.shift()!);
    await runWorker();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retries on CloudFlare rate-limit class 401/403/429", async () => {
    for (const status of [401, 403, 429]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResp("", false, status))
        .mockResolvedValue(jsonResp({ columns: ["message", "creation_date"], rows: [] }));
      await runWorker();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("throws on 400 (non-retryable) and main catches", async () => {
    fetchMock.mockResolvedValue(jsonResp("bad", false, 400));
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toMatch(/fatal: API 400/);
    expect(releaseLockMock).toHaveBeenCalled();
  });
});

// ═══ finalize + release + empty summary ═══════════════════════════════════

describe("codex wiki-worker — finalize + release edges", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const sql = JSON.parse(init.body).query as string;
      if (sql.startsWith("SELECT message")) return jsonResp({ columns: ["message", "creation_date"], rows: [["{}", "t"]] });
      if (sql.startsWith("SELECT DISTINCT path")) return jsonResp({ columns: ["path"], rows: [["/x.jsonl"]] });
      return jsonResp({ columns: ["summary"], rows: [] });
    });
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[2].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "# s\n\n## What Happened\nX\n");
      return Buffer.from("");
    });
  });

  it("logs sidecar update failure but still releases lock", async () => {
    finalizeSummaryMock.mockImplementation(() => { throw new Error("sidecar boom"); });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("sidecar update failed: sidecar boom");
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("swallows releaseLock throw in finally", async () => {
    releaseLockMock.mockImplementation(() => { throw new Error("release boom"); });
    await runWorker();
    const log = readFileSync(join(hooksDir, "wiki.log"), "utf-8");
    expect(log).toContain("done");
  });

  it("skips upload when summary file is whitespace-only", async () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const summaryPath = args[2].match(/SUMMARY=(\S+)/)![1];
      writeFileSync(summaryPath, "   \n\n");
      return Buffer.from("");
    });
    await runWorker();
    expect(uploadSummaryMock).not.toHaveBeenCalled();
    expect(finalizeSummaryMock).not.toHaveBeenCalled();
  });
});
