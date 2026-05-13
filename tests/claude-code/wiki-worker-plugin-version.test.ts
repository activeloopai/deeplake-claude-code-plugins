import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Functional pluginVersion threading test for the cursor / hermes / pi
 * wiki-worker variants.
 *
 * `claude-code/tests/wiki-worker.test.ts` already exhaustively tests the
 * shared worker structure for the claude-code variant. This file is a
 * narrower guard: for each of the three sibling agents, the worker MUST
 * read `cfg.pluginVersion` from its spawn-config JSON and forward it to
 * `uploadSummary`. A regression there silently lands empty plugin_version
 * strings in every summary row from those agents.
 *
 * Why a separate file: the variants differ from claude-code only in the
 * LLM-spawn step (binary + flags), which is already locked in by
 * `cursor-wiki-worker-source.test.ts` / `hermes-wiki-worker-source.test.ts`.
 * Re-testing the whole happy path × 3 would duplicate ~1.5k lines of
 * existing coverage. We exercise enough of main() to reach the upload
 * call, then assert on the uploadSummary call payload.
 */

const finalizeSummaryMock = vi.fn();
const releaseLockMock = vi.fn();
const uploadSummaryMock = vi.fn();
const execFileSyncMock = vi.fn();
const embedSummaryMock = vi.fn();
const fetchMock = vi.fn();
const originalFetch = global.fetch;
const originalArgv2 = process.argv[2];

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

let rootDir: string;
let tmpDir: string;
let hooksDir: string;
let configPath: string;

interface AgentVariant {
  agent: "cursor" | "hermes" | "pi";
  workerPath: string;
  cfgExtra: Record<string, unknown>;
}

const PROMPT_TEMPLATE = "JSONL=__JSONL__ SUMMARY=__SUMMARY__ SID=__SESSION_ID__ PROJ=__PROJECT__ OFFSET=__PREV_OFFSET__ LINES=__JSONL_LINES__ SRC=__JSONL_SERVER_PATH__";

function makeCfg(extra: Record<string, unknown>, pluginVersion: string): Record<string, unknown> {
  return {
    apiUrl: "http://fake.local",
    token: "tok",
    orgId: "org",
    workspaceId: "default",
    memoryTable: "memory",
    sessionsTable: "sessions",
    sessionId: "sid-pv",
    userName: "alice",
    project: "proj",
    pluginVersion,
    tmpDir,
    wikiLog: join(hooksDir, "wiki.log"),
    hooksDir,
    promptTemplate: PROMPT_TEMPLATE,
    ...extra,
  };
}

function jsonResp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "wiki-pv-test-"));
  tmpDir = join(rootDir, "tmp");
  hooksDir = join(rootDir, "hooks");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  configPath = join(rootDir, "config.json");
  fetchMock.mockReset();
  finalizeSummaryMock.mockReset();
  releaseLockMock.mockReset();
  uploadSummaryMock.mockReset().mockResolvedValue({ path: "insert", summaryLength: 100, descLength: 20, sql: "..." });
  embedSummaryMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  // execFileSync stub: simulate the LLM by writing the summary file the
  // worker expects (matches the real binary's contract).
  execFileSyncMock.mockReset().mockImplementation(() => {
    writeFileSync(join(tmpDir, "summary.md"), "# Session sid-pv\n\n## What Happened\nstub summary\n");
    return "";
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  process.argv[2] = originalArgv2;
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

async function runVariant(variant: AgentVariant, pluginVersion: string): Promise<void> {
  writeFileSync(configPath, JSON.stringify(makeCfg(variant.cfgExtra, pluginVersion)));
  process.argv[2] = configPath;
  // Two SQL calls the worker makes before upload: SELECT events + SELECT DISTINCT path.
  // Then SELECT summary FROM "memory" WHERE path = ... LIMIT 1 (to resume).
  fetchMock.mockImplementation(async (_url: string, init: any) => {
    const sql = JSON.parse(init.body).query as string;
    if (sql.startsWith("SELECT message, creation_date")) {
      return jsonResp({
        columns: ["message", "creation_date"],
        rows: [[JSON.stringify({ type: "user_message", content: "hi" }), "2026-04-20T00:00:00Z"]],
      });
    }
    if (sql.startsWith("SELECT DISTINCT path")) {
      return jsonResp({ columns: ["path"], rows: [[`/sessions/alice/alice_org_default_sid-pv.jsonl`]] });
    }
    if (sql.startsWith("SELECT summary FROM")) {
      return jsonResp({ columns: ["summary"], rows: [] });
    }
    return jsonResp({ columns: [], rows: [] });
  });
  global.fetch = fetchMock;
  vi.resetModules();
  await import(variant.workerPath);
  // Let main() and all awaits settle.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

const VARIANTS: AgentVariant[] = [
  {
    agent: "cursor",
    workerPath: "../../src/hooks/cursor/wiki-worker.js",
    cfgExtra: { cursorBin: "/fake/cursor", cursorModel: "auto" },
  },
  {
    agent: "hermes",
    workerPath: "../../src/hooks/hermes/wiki-worker.js",
    cfgExtra: { hermesBin: "/fake/hermes", hermesProvider: "openrouter", hermesModel: "anthropic/claude-haiku-4-5" },
  },
  {
    agent: "pi",
    workerPath: "../../src/hooks/pi/wiki-worker.js",
    cfgExtra: { piBin: "/fake/pi", piProvider: "openrouter", piModel: "anthropic/claude-haiku-4-5" },
  },
];

describe("wiki-worker pluginVersion threading — per agent", () => {
  for (const v of VARIANTS) {
    it(`${v.agent}: forwards cfg.pluginVersion into uploadSummary`, async () => {
      await runVariant(v, "1.2.3");
      expect(uploadSummaryMock).toHaveBeenCalledOnce();
      const params = uploadSummaryMock.mock.calls[0][1];
      expect(params.pluginVersion).toBe("1.2.3");
      expect(params.agent).toBe(v.agent);
      expect(params.userName).toBe("alice");
    });

    it(`${v.agent}: forwards '' when cfg omits pluginVersion (legacy spawner)`, async () => {
      // Use a runVariant variant that strips pluginVersion from the cfg.
      const cfg = makeCfg(v.cfgExtra, "");
      delete (cfg as Record<string, unknown>).pluginVersion;
      writeFileSync(configPath, JSON.stringify(cfg));
      process.argv[2] = configPath;
      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const sql = JSON.parse(init.body).query as string;
        if (sql.startsWith("SELECT message, creation_date")) {
          return jsonResp({
            columns: ["message", "creation_date"],
            rows: [[JSON.stringify({ type: "user_message", content: "hi" }), "2026-04-20T00:00:00Z"]],
          });
        }
        if (sql.startsWith("SELECT DISTINCT path")) {
          return jsonResp({ columns: ["path"], rows: [[`/sessions/alice/alice_org_default_sid-pv.jsonl`]] });
        }
        if (sql.startsWith("SELECT summary FROM")) {
          return jsonResp({ columns: ["summary"], rows: [] });
        }
        return jsonResp({ columns: [], rows: [] });
      });
      global.fetch = fetchMock;
      vi.resetModules();
      await import(v.workerPath);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(uploadSummaryMock).toHaveBeenCalledOnce();
      const params = uploadSummaryMock.mock.calls[0][1];
      // The `?? ""` fallback must kick in — never `undefined` (which would
      // become a SQL NULL through the literal interpolation in upload-summary.
      expect(params.pluginVersion).toBe("");
    });
  }
});

// ─── Branch coverage helpers ───────────────────────────────────────────────
//
// The remaining branches in each variant's main() are:
//   - LLM-spawn failure path (execFileSync throws)
//   - "no summary file generated" branch (existsSync(tmpSummary) === false)
//   - empty summary branch (text.trim() === "")
//   - early-exit branch (no session events found)
//
// Each scenario covered once on cursor is enough to exercise the shared
// shape; the agent-specific bits are locked in by cursor-wiki-worker-source
// / hermes-wiki-worker-source tests. We still parametrize across all three
// agents so a regression on one variant doesn't slip past.

describe("wiki-worker API retry path — per agent", () => {
  // The query() helper inside each worker has its own retry loop for
  // transient API failures (401/403/429/500/502/503). Without exercising
  // it the back-pressure branch stays at 0 % coverage even though the
  // file is otherwise green. Stub setTimeout so the test doesn't wait
  // multi-second exponential backoff windows.
  let originalSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      // Run the callback synchronously on next microtask — close enough
      // for the worker's `await new Promise(r => setTimeout(r, delay))`.
      Promise.resolve().then(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;
  });
  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  for (const v of VARIANTS) {
    it(`${v.agent}: 503 → 200 retry succeeds and continues to upload`, async () => {
      writeFileSync(configPath, JSON.stringify(makeCfg(v.cfgExtra, "9.9.9")));
      process.argv[2] = configPath;
      let firstEventsCall = true;
      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const sql = JSON.parse(init.body).query as string;
        if (sql.startsWith("SELECT message, creation_date")) {
          if (firstEventsCall) {
            firstEventsCall = false;
            return jsonResp("upstream temporarily unavailable", false, 503);
          }
          return jsonResp({
            columns: ["message", "creation_date"],
            rows: [[JSON.stringify({ type: "user_message", content: "hi" }), "2026-04-20T00:00:00Z"]],
          });
        }
        if (sql.startsWith("SELECT DISTINCT path")) {
          return jsonResp({ columns: ["path"], rows: [["/sessions/alice/alice_org_default_sid-pv.jsonl"]] });
        }
        if (sql.startsWith("SELECT summary FROM")) {
          return jsonResp({ columns: ["summary"], rows: [] });
        }
        return jsonResp({ columns: [], rows: [] });
      });
      global.fetch = fetchMock;
      vi.resetModules();
      await import(v.workerPath);
      // Extra ticks for the retry path's awaited setTimeout.
      for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

      expect(uploadSummaryMock).toHaveBeenCalledOnce();
      expect(uploadSummaryMock.mock.calls[0][1].pluginVersion).toBe("9.9.9");
    });
  }
});

describe("wiki-worker resume + embeddings-disabled branches — per agent", () => {
  for (const v of VARIANTS) {
    it(`${v.agent}: resumed session — reads existing summary and parses offset`, async () => {
      // When a summary row already exists at /summaries/<user>/<sid>.md the
      // worker reads it, parses the `**JSONL offset**` line, and re-uses
      // both as the resume baseline for the LLM prompt. Hits the otherwise
      // uncovered branch in main() (lines ~150-155 in the cursor variant).
      writeFileSync(configPath, JSON.stringify(makeCfg(v.cfgExtra, "9.9.9")));
      process.argv[2] = configPath;
      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const sql = JSON.parse(init.body).query as string;
        if (sql.startsWith("SELECT message, creation_date")) {
          return jsonResp({
            columns: ["message", "creation_date"],
            rows: [[JSON.stringify({ type: "user_message", content: "hi" }), "2026-04-20T00:00:00Z"]],
          });
        }
        if (sql.startsWith("SELECT DISTINCT path")) {
          return jsonResp({ columns: ["path"], rows: [["/sessions/alice/alice_org_default_sid-pv.jsonl"]] });
        }
        if (sql.startsWith("SELECT summary FROM")) {
          // Existing summary with a JSONL offset marker → triggers the
          // resume branch + parseInt extraction.
          return jsonResp({
            columns: ["summary"],
            rows: [["# Session sid-pv\n- **JSONL offset**: 42\n\n## What Happened\nprior"]],
          });
        }
        return jsonResp({ columns: [], rows: [] });
      });
      global.fetch = fetchMock;
      vi.resetModules();
      await import(v.workerPath);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(uploadSummaryMock).toHaveBeenCalledOnce();
      // The pluginVersion still threads through on resume.
      expect(uploadSummaryMock.mock.calls[0][1].pluginVersion).toBe("9.9.9");
    });

    it(`${v.agent}: HIVEMIND_EMBEDDINGS=false skips the embed daemon`, async () => {
      // Hit the embeddingsDisabled() branch — uploadSummary should still
      // be called, but with embedding === null (skipped daemon hop).
      const prev = process.env.HIVEMIND_EMBEDDINGS;
      process.env.HIVEMIND_EMBEDDINGS = "false";
      try {
        await runVariant(v, "9.9.9");
        expect(uploadSummaryMock).toHaveBeenCalledOnce();
        const params = uploadSummaryMock.mock.calls[0][1];
        expect(params.embedding).toBeNull();
        expect(params.pluginVersion).toBe("9.9.9");
      } finally {
        if (prev === undefined) delete process.env.HIVEMIND_EMBEDDINGS;
        else process.env.HIVEMIND_EMBEDDINGS = prev;
      }
    });
  }
});

describe("wiki-worker error / edge-case branches — per agent", () => {
  for (const v of VARIANTS) {
    it(`${v.agent}: LLM-spawn failure → no upload, releaseLock still fires`, async () => {
      // execFileSync throws (binary crashed / missing / timed out). Worker
      // logs the failure and falls through to the upload block — but since
      // no summary file was written, existsSync is false → no upload.
      execFileSyncMock.mockImplementation(() => {
        const err = new Error("spawn ENOENT");
        (err as any).status = 127;
        throw err;
      });
      await runVariant(v, "9.9.9");
      expect(uploadSummaryMock).not.toHaveBeenCalled();
      expect(releaseLockMock).toHaveBeenCalledWith("sid-pv");
    });

    it(`${v.agent}: empty summary file → no upload, releaseLock still fires`, async () => {
      // LLM "succeeds" but writes only whitespace. text.trim() returns ""
      // → upload skipped. The releaseLock-in-finally still runs.
      execFileSyncMock.mockImplementation(() => {
        writeFileSync(join(tmpDir, "summary.md"), "   \n\t\n");
        return "";
      });
      await runVariant(v, "9.9.9");
      expect(uploadSummaryMock).not.toHaveBeenCalled();
      expect(releaseLockMock).toHaveBeenCalledWith("sid-pv");
    });

    it(`${v.agent}: no session events → early exit, no upload, no LLM spawn`, async () => {
      const cfg = makeCfg(v.cfgExtra, "9.9.9");
      writeFileSync(configPath, JSON.stringify(cfg));
      process.argv[2] = configPath;
      // SELECT message returns 0 rows → worker logs "no session events
      // found" and exits early before invoking the LLM or upload path.
      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const sql = JSON.parse(init.body).query as string;
        if (sql.startsWith("SELECT message, creation_date")) {
          return jsonResp({ columns: ["message", "creation_date"], rows: [] });
        }
        return jsonResp({ columns: [], rows: [] });
      });
      global.fetch = fetchMock;
      vi.resetModules();
      await import(v.workerPath);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(uploadSummaryMock).not.toHaveBeenCalled();
      expect(releaseLockMock).toHaveBeenCalledWith("sid-pv");
    });
  }
});
