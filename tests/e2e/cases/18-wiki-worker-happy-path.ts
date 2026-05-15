/**
 * Wiki worker happy path: session ends → worker spawns → memory row lands.
 *
 * The wiki worker generates a session summary by running the agent's CLI
 * with a summarization prompt against the captured session rows, then
 * INSERTs the produced text into the `memory` table. This case asserts
 * that one full round-trip produces a memory row tagged with the
 * session's id.
 *
 * Coverage gap closed: case 12 (recursion-guard) tests that the worker
 * short-circuits when HIVEMIND_WIKI_WORKER=1 is in env, but the happy
 * path — worker spawns, runs, writes — has no case. A regression that
 * makes the worker silently produce nothing (e.g. a gate prompt change
 * that returns no JSON, an INSERT shape mismatch) wouldn't surface in
 * the existing matrix.
 *
 * The wiki worker is async and runs DETACHED from session-end. We give
 * it a wall-clock budget via the case's timeout (90s default) for the
 * LLM call + INSERT to complete. A faster CI would shorten this; for
 * a manual matrix run, 90s is fine.
 *
 * Skipped on openclaw — its summary path is different (in-band wiki via
 * a different code path, not the session-end subprocess pattern).
 */

import type { E2ECase } from "../types.js";

const wikiWorkerHappyPathCase: E2ECase = {
  id: "18-wiki-worker-happy-path",
  description:
    "session ends → wiki-worker spawns → memory row with summary lands within the case's timeout",
  prompt:
    "Tell me one short fact about Mercury (one sentence), then say 'done'. " +
    "Do not call tools.",
  assertions: [
    {
      type: "hook-log-contains",
      substring: "wiki",
      label: "wiki-worker spawn line present in hook-debug.log post-run",
    },
    {
      type: "select-from-db",
      label: "at least one memory row tagged with this session_id lands within timeout",
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.memoryTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%'`,
      expect: (rows) => {
        if (rows.length === 0) {
          throw new Error("count query returned no rows");
        }
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(
            `no memory row for this session_id — wiki worker did not produce a summary within the case timeout`,
          );
        }
      },
    },
  ],
  skipFor: ["openclaw"],
};

export default wikiWorkerHappyPathCase;
