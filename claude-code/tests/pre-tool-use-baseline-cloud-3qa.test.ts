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
import { processPreToolUse } from "../../src/hooks/pre-tool-use.js";
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
  it("pure builder renders a real 272-row index without the old '0 sessions:' bug", () => {
    const content = buildVirtualIndexContent([], SESSION_ROWS);

    expect(content).toContain("272 entries (0 summaries, 272 sessions):");
    expect(content).toContain("## Sessions");
    expect(content).not.toContain("## Summaries");
    // Bug guard: the old output had a lone "${n} sessions:" header with
    // n taken from summary rows only. In this workspace that would be 0.
    expect(content).not.toMatch(/^0 sessions:$/m);
    expect(content).not.toContain("\n0 sessions:\n");

    // Every real session path from the fixture must appear in the index.
    for (const row of SESSION_ROWS) {
      expect(content).toContain(row.path);
    }
  });

  it("readVirtualPathContents fallback pulls sessions into /index.md for the baseline workspace", async () => {
    const api = makeBaselineWorkspaceApi();
    const result = await readVirtualPathContents(api, "memory", "sessions", ["/index.md"]);
    const indexContent = result.get("/index.md") ?? "";

    expect(indexContent).toContain("272 entries (0 summaries, 272 sessions):");
    // Must land on the three sessions that carry answers for our 3 real QAs.
    for (const qa of REAL_QAS) {
      expect(indexContent).toContain(qa.expected_session_file);
    }
  });

  for (const qa of REAL_QAS) {
    describe(qa.name, () => {
      it("Read /home/.deeplake/memory/index.md intercept returns the real session listing (not '1 sessions:')", async () => {
        const api = makeBaselineWorkspaceApi();

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
          },
        );

        expect(decision).not.toBeNull();
        const body = decision?.command ?? "";
        expect(body).toContain("# Memory Index");
        expect(body).toContain("272 entries (0 summaries, 272 sessions):");
        expect(body).toContain(qa.expected_session_file);
        // Regression guard: the old (buggy) synthesized index printed
        // "<n> sessions:" where n was the count of summary rows only.
        expect(body).not.toMatch(/\b0 sessions:/);
        expect(body).not.toMatch(/\b1 sessions:/);
      });

      it("Bash cat index.md intercept returns the same real session listing", async () => {
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
        const body = decision?.command ?? "";
        expect(body).toContain("272 entries (0 summaries, 272 sessions):");
        expect(body).toContain(qa.expected_session_file);
      });
    });
  }
});
