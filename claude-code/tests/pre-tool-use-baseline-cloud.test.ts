/**
 * Integration coverage for the three real LoCoMo QAs that the
 * `locomo_benchmark/baseline` cloud baseline run got wrong before fix
 * #1 landed. Each case exercises the Read/Bash entry points of
 * `processPreToolUse` against a workspace snapshot that mirrors the
 * real baseline workspace at the time of the regression:
 *
 *   - `memory` table:   empty (summaries have been dropped)
 *   - `sessions` table: 272 rows, one per LoCoMo session file
 *
 * The fix (commit 4271baf) taught `buildVirtualIndexContent` and the
 * /index.md fallback in `readVirtualPathContents` to merge session rows
 * alongside summary rows. Without that fix the synthesized index
 * reported "0 sessions:" in this workspace and agents concluded memory
 * was empty. These tests fail loudly if the regression returns.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPreToolUse, writeReadCacheFile } from "../../src/hooks/pre-tool-use.js";
import {
  buildVirtualIndexContent,
  readVirtualPathContents,
} from "../../src/hooks/virtual-table-query.js";

// ── Fixture: 272 session rows matching the real `locomo_benchmark/baseline`
// workspace shape — `/sessions/conv_<c>_session_<s>.json` — spanning
// conv 0..9 with session counts matching the LoCoMo dataset.
const SESSION_COUNTS_PER_CONV: Record<number, number> = {
  0: 35, 1: 34, 2: 28, 3: 25, 4: 26, 5: 27, 6: 23, 7: 27, 8: 26, 9: 21,
};

function makeSessionRows(): Array<{ path: string; description: string }> {
  const rows: Array<{ path: string; description: string }> = [];
  for (const [conv, count] of Object.entries(SESSION_COUNTS_PER_CONV)) {
    for (let s = 1; s <= count; s++) {
      rows.push({
        path: `/sessions/conv_${conv}_session_${s}.json`,
        description: `LoCoMo conv ${conv} session ${s}`,
      });
    }
  }
  return rows;
}

const SESSION_ROWS = makeSessionRows();

// Sanity-check the fixture shape so a bad edit fails here, not deep in a test.
if (SESSION_ROWS.length !== 272) {
  throw new Error(`fixture should model 272 rows, got ${SESSION_ROWS.length}`);
}

// ── Real QAs from `results/baseline_cloud/scored_baseline_cloud.jsonl`
// that baseline-local got right and baseline-cloud got wrong before the
// fix. Each row is verbatim from the scored JSONL except `session_file`
// which records the session we'd expect Claude to land on.
const REAL_QAS = [
  {
    name: "qa_3: Caroline's research (fix #2 smoke — real run did Read x3)",
    question: "What did Caroline research?",
    gold_answer: "Adoption agencies",
    expected_session_file: "/sessions/conv_0_session_1.json",
  },
  {
    name: "qa_6: Melanie's camping plans",
    question: "When is Melanie planning on going camping?",
    gold_answer: "June 2023",
    expected_session_file: "/sessions/conv_0_session_2.json",
  },
  {
    name: "qa_25: Caroline's LGBTQ conference",
    question: "When did Caroline go to the LGBTQ conference?",
    gold_answer: "10 July 2023",
    expected_session_file: "/sessions/conv_0_session_7.json",
  },
  {
    name: "qa_29: Melanie's pottery workshop",
    question: "When did Melanie go to the pottery workshop?",
    gold_answer: "The Friday before 15 July 2023",
    expected_session_file: "/sessions/conv_0_session_7.json",
  },
  {
    name: "qa_46: Melanie as an ally",
    question: "Would Melanie be considered an ally to the transgender community?",
    gold_answer: "Yes, she is supportive",
    expected_session_file: "/sessions/conv_0_session_10.json",
  },
] as const;

const BASE_CONFIG = {
  token: "test-token",
  apiUrl: "https://api.test",
  orgId: "locomo_benchmark",
  workspaceId: "baseline",
};

/** Simulates the real baseline workspace: memory empty, sessions populated. */
function makeBaselineWorkspaceApi(sessionRows = SESSION_ROWS) {
  return {
    query: vi.fn(async (sql: string) => {
      // Memory-table queries return 0 rows (memory table dropped).
      if (/FROM\s+"memory"/i.test(sql)) return [];
      // Sessions-table fallback query for the virtual /index.md:
      if (/FROM\s+"sessions".*\/sessions\/%/i.test(sql)) return sessionRows;
      // Union query for exact-path reads of /index.md resolves to nothing —
      // forces the fallback branch that builds the synthetic index.
      if (/UNION ALL/i.test(sql)) return [];
      return [];
    }),
  } as any;
}

describe("baseline_cloud 3-QA regression: sessions-only workspace", () => {
  it("pure builder renders the full session listing without the old '0 sessions:' bug", () => {
    const content = buildVirtualIndexContent([], SESSION_ROWS);

    expect(content).toContain("# Session Index");
    expect(content).toContain("## sessions");
    // Memory section is always emitted now; on an empty memory it carries
    // an explicit empty notice. That replaces the pre-fix logic that
    // omitted the section header — we keep both bits visible.
    expect(content).toContain("## memory");
    expect(content).toContain("_(empty — no summaries ingested yet)_");
    // Original bug guard: the old output had a lone "${n} sessions:" header
    // sourced from summary-row count only. The new format has no count line
    // at all, so these regex anchors stay green.
    expect(content).not.toMatch(/^0 sessions:$/m);
    expect(content).not.toContain("\n0 sessions:\n");

    // Every real session path from the fixture must appear in the rendered
    // table. Paths render workspace-relative (no leading slash) so we strip
    // the slash before checking.
    for (const row of SESSION_ROWS) {
      expect(content).toContain(row.path.slice(1));
    }
  });

  it("readVirtualPathContents fallback pulls sessions into /index.md for the baseline workspace", async () => {
    const api = makeBaselineWorkspaceApi();
    const result = await readVirtualPathContents(api, "memory", "sessions", ["/index.md"]);
    const indexContent = result.get("/index.md") ?? "";

    expect(indexContent).toContain("# Session Index");
    expect(indexContent).toContain("## sessions");
    // The fallback now slices to the first 50 most-recently-updated rows
    // (LIMIT in the SQL keeps DB cost bounded; slice trims the +1 sentinel
    // used to detect truncation). The fixture's first 50 in insertion order
    // happen to be conv_0_session_1..35 + conv_1_session_1..15, which
    // covers all REAL_QAs (conv 0 sessions 1, 2, 7, 10).
    for (const qa of REAL_QAS) {
      expect(indexContent).toContain(qa.expected_session_file.slice(1));
    }
  });

  for (const qa of REAL_QAS) {
    describe(qa.name, () => {
      it("Read /home/.deeplake/memory/index.md intercept returns file_path (Read-tool shape) pointing to the real session listing", async () => {
        const api = makeBaselineWorkspaceApi();
        const capturedReadFiles: Array<{ sessionId: string; virtualPath: string; content: string; returnedPath: string }> = [];

        const decision = await processPreToolUse(
          {
            session_id: `s-${qa.expected_session_file}`,
            tool_name: "Read",
            tool_input: { file_path: "~/.deeplake/memory/index.md" },
            tool_use_id: "tu-read-index",
          },
          {
            config: BASE_CONFIG,
            createApi: vi.fn(() => api),
            executeCompiledBashCommandFn: vi.fn(async () => null) as any,
            readCachedIndexContentFn: () => null,
            writeCachedIndexContentFn: () => undefined,
            writeReadCacheFileFn: ((sessionId: string, virtualPath: string, content: string) => {
              const returnedPath = `/tmp/baseline-cloud-3qa-test-${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}${virtualPath}`;
              capturedReadFiles.push({ sessionId, virtualPath, content, returnedPath });
              return returnedPath;
            }) as any,
          },
        );

        // Regression guard for bug #2: Read intercept MUST return a decision
        // that causes main() to emit `updatedInput: {file_path}`. Today that
        // means the decision carries `file_path`. If this asserts "undefined",
        // Claude Code's Read tool will error with "path must be of type string".
        expect(decision).not.toBeNull();
        expect(decision?.file_path).toBeDefined();
        expect(typeof decision?.file_path).toBe("string");

        // Content must be materialized once, with the real index shape.
        expect(capturedReadFiles).toHaveLength(1);
        const materialized = capturedReadFiles[0];
        expect(materialized?.virtualPath).toBe("/index.md");
        expect(decision?.file_path).toBe(materialized?.returnedPath);

        const body = materialized?.content ?? "";
        expect(body).toContain("# Session Index");
        expect(body).toContain("## sessions");
        // Path renders without leading slash (workspace-relative link target).
        expect(body).toContain(qa.expected_session_file.slice(1));
        // Fix #1 regression guard (still important after fix #2): the old
        // synthesized index reported sessions from the memory table only.
        // The new format has no count line at all so these regex stay green.
        expect(body).not.toMatch(/\b0 sessions:/);
        expect(body).not.toMatch(/\b1 sessions:/);
      });

      it("Bash cat index.md intercept returns the same listing via {command} (bash shape preserved)", async () => {
        const api = makeBaselineWorkspaceApi();

        const decision = await processPreToolUse(
          {
            session_id: `s-bash-${qa.expected_session_file}`,
            tool_name: "Bash",
            tool_input: { command: "cat ~/.deeplake/memory/index.md" },
            tool_use_id: "tu-cat-index",
          },
          {
            config: BASE_CONFIG,
            createApi: vi.fn(() => api),
            executeCompiledBashCommandFn: vi.fn(async () => null) as any,
            readCachedIndexContentFn: () => null,
            writeCachedIndexContentFn: () => undefined,
          },
        );

        expect(decision).not.toBeNull();
        // Bash intercepts keep the historical {command, description} shape —
        // Claude Code's Bash tool reads `command`. The content is inlined as
        // an `echo "..."` payload so the virtual shell isn't needed here.
        expect(decision?.file_path).toBeUndefined();
        const body = decision?.command ?? "";
        expect(body).toContain("# Session Index");
        // Path renders without leading slash (workspace-relative link target).
        expect(body).toContain(qa.expected_session_file.slice(1));
      });
    });
  }

  // ── Regression coverage anchored in a real benchmark run ─────────────
  //
  // In `baseline_cloud_9qa_read_candidates_fix2` (2026-04-20), haiku chose
  // to call the Read tool directly against session files — not just
  // /index.md. Specifically, qa_3 did three Read calls including
  // Read /home/.deeplake/memory/sessions/conv_0_session_1.json and
  // Read /home/.deeplake/memory/sessions/conv_0_session_2.json, and all
  // three succeeded (zero "path must be of type string" errors) after
  // fix #2 landed. The previous run on the same workspace without the fix
  // produced that error on every memory-path Read call.
  //
  // This test drives the same session-file Read through processPreToolUse
  // and asserts the decision shape matches what Claude Code's Read tool
  // expects — i.e. `updatedInput: {file_path}`, not `{command}`.

  it("Read /sessions/<file> intercept returns file_path pointing to the session content (qa_3 real-run path)", async () => {
    const sessionJson = JSON.stringify({
      conversation_id: 0,
      session_number: 1,
      date_time: "8 May, 2023",
      speakers: { speaker_a: "Caroline", speaker_b: "Melanie" },
      turns: [
        { speaker: "Caroline", dia_id: "D1:1", text: "Hey Mel! Good to see you!" },
      ],
    });

    const api = {
      query: vi.fn(async (sql: string) => {
        // Exact-path read hits the sessions table.
        if (/FROM\s+"sessions"/i.test(sql) && /conv_0_session_1\.json/.test(sql)) {
          return [{ path: "/sessions/conv_0_session_1.json", content: sessionJson, source_order: 1 }];
        }
        if (/FROM\s+"memory"/i.test(sql)) return [];
        return [];
      }),
    } as any;
    const capturedReadFiles: Array<{ sessionId: string; virtualPath: string; content: string }> = [];

    const decision = await processPreToolUse(
      {
        session_id: "s-qa3-session-read",
        tool_name: "Read",
        tool_input: { file_path: "~/.deeplake/memory/sessions/conv_0_session_1.json" },
        tool_use_id: "tu-read-session-1",
      },
      {
        config: BASE_CONFIG,
        createApi: vi.fn(() => api),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readCachedIndexContentFn: () => null,
        writeCachedIndexContentFn: () => undefined,
        writeReadCacheFileFn: ((sessionId: string, virtualPath: string, content: string) => {
          capturedReadFiles.push({ sessionId, virtualPath, content });
          return `/tmp/test-${sessionId}${virtualPath}`;
        }) as any,
      },
    );

    // Read-tool shape: decision must carry file_path, not just command.
    expect(decision).not.toBeNull();
    expect(decision?.file_path).toBe("/tmp/test-s-qa3-session-read/sessions/conv_0_session_1.json");

    // Content materialized exactly once, at the right virtual path, with
    // the real session payload Claude needs to answer qa_3.
    expect(capturedReadFiles).toHaveLength(1);
    expect(capturedReadFiles[0]?.virtualPath).toBe("/sessions/conv_0_session_1.json");
    expect(capturedReadFiles[0]?.content).toContain("Caroline");
    expect(capturedReadFiles[0]?.content).toContain("8 May, 2023");
  });

  // ── writeReadCacheFile security guard ─────────────────────────────────────
  //
  // Claude Code's Read intercept materializes fetched content into
  // ~/.deeplake/query-cache/<session_id>/read/<virtualPath>. DB-derived
  // virtualPaths are user-controlled (anyone with write access to the
  // `sessions` / `memory` tables controls them), so `..` segments must not
  // be allowed to escape the per-session cache dir. The PR #63 bot review
  // flagged this.

  describe("writeReadCacheFile path-traversal guard", () => {
    it("writes a well-formed virtualPath inside the per-session cache root", () => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "writeReadCache-ok-"));
      try {
        const abs = writeReadCacheFile("sess-1", "/sessions/conv_0_session_1.json", "hello", { cacheRoot });
        expect(abs).toBe(join(cacheRoot, "sess-1", "read", "sessions", "conv_0_session_1.json"));
        expect(existsSync(abs)).toBe(true);
        expect(readFileSync(abs, "utf-8")).toBe("hello");
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    it("refuses a virtualPath that escapes the cache root via ../ segments", () => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "writeReadCache-trav-"));
      try {
        expect(() =>
          writeReadCacheFile("sess-2", "/sessions/../../../etc/passwd", "pwned", { cacheRoot })
        ).toThrow(/path escapes cache root/);
        // Guard must fire BEFORE any write lands anywhere under cacheRoot.
        expect(existsSync(join(cacheRoot, "sess-2", "read", "sessions"))).toBe(false);
        expect(existsSync(join(cacheRoot, "etc"))).toBe(false);
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    it("refuses traversal that lands outside the cache root entirely", () => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "writeReadCache-out-"));
      try {
        // Resolves to something like /tmp/writeReadCache-out-XXX/sess-3/read/../../../../../../etc/shadow
        // → /etc/shadow — fully outside cacheRoot.
        expect(() =>
          writeReadCacheFile("sess-3", "/../../../../../../etc/shadow", "x", { cacheRoot })
        ).toThrow(/path escapes cache root/);
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    it("accepts a path that normalizes back inside the cache root", () => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "writeReadCache-norm-"));
      try {
        // `/sessions/foo/../bar.json` → `/sessions/bar.json`, still inside.
        const abs = writeReadCacheFile("sess-4", "/sessions/foo/../bar.json", "ok", { cacheRoot });
        expect(abs).toBe(join(cacheRoot, "sess-4", "read", "sessions", "bar.json"));
        expect(readFileSync(abs, "utf-8")).toBe("ok");
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  // ── /index.md fallback lives in virtual-table-query.ts only ───────────────
  //
  // An earlier draft of fix #1 duplicated the synthesized-index builder
  // inside pre-tool-use.ts. The bot review flagged that duplicate as
  // unreachable + using the old single-table SQL ("N sessions:" header,
  // missing `## Sessions`). The duplicate has since been removed; this
  // test locks in that removal — `processPreToolUse` must use the dual-
  // table builder and never synthesize its own broken fallback.

  it("index.md intercept never falls back to the single-table inline builder", async () => {
    // readVirtualPathContentFn returns non-null for /index.md (fix #1
    // guarantee), so the old inline fallback is now unreachable. If
    // somebody re-introduces it, this test fails because the bad string
    // "${n} sessions:" would appear in the output instead of the dual-
    // table "${total} entries (${s} summaries, ${n} sessions):" header.
    const api = { query: vi.fn(async () => []) } as any;
    const readVirtualPathContentFn = vi.fn(async () => "# Session Index\n\n## sessions\n\n| Session | Created | Last Updated | Description |\n|---------|---------|--------------|-------------|\n| [conv_0_session_1.json](sessions/conv_0_session_1.json) |  |  |  |\n");
    let materialized: string | undefined;

    const decision = await processPreToolUse(
      {
        session_id: "s-index-fallback",
        tool_name: "Read",
        tool_input: { file_path: "~/.deeplake/memory/index.md" },
        tool_use_id: "tu-fallback",
      },
      {
        config: BASE_CONFIG,
        createApi: vi.fn(() => api),
        readVirtualPathContentFn: readVirtualPathContentFn as any,
        readCachedIndexContentFn: () => null,
        writeCachedIndexContentFn: () => undefined,
        writeReadCacheFileFn: ((_sid: string, _vp: string, content: string) => {
          materialized = content;
          return "/tmp/fake-index-path";
        }) as any,
      },
    );

    expect(decision).not.toBeNull();
    expect(materialized).toBeDefined();
    // The dual-table builder's content was materialized, not any inline
    // fallback. New format: "# Session Index" header + "## sessions" section.
    expect(materialized).toContain("# Session Index");
    expect(materialized).toContain("## sessions");
    // Pre-fix bug-shape "${n} sessions:" header must not reappear.
    expect(materialized).not.toMatch(/\n\d+ sessions:\n/);
    // Production code must not issue its own fallback SELECT against
    // memory for /index.md — it delegates entirely to readVirtualPath.
    const summariesOnlyFallback = api.query.mock.calls.find((call: any[]) =>
      String(call[0] || "").includes(`FROM "memory" WHERE path LIKE '/summaries/%'`)
    );
    expect(summariesOnlyFallback).toBeUndefined();
  });
});
