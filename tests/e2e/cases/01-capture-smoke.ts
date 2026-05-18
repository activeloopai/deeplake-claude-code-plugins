/**
 * Capture smoke: agent runs one turn, exactly one prompt-row lands in
 * the sessions table. The baseline case — proves the install + hook
 * wiring + Deeplake INSERT happy path end-to-end. If this fails, no
 * other case can succeed.
 *
 * We don't assert on the agent's textual answer — model output is
 * non-deterministic, and the harness's whole point is to test the
 * plugin, not the model. We only assert on the side effect (DB rows)
 * and that the hook logged the session_id.
 */

import type { E2ECase } from "../types.js";

const captureSmokeCase: E2ECase = {
  id: "01-capture-smoke",
  description:
    "one agent turn → at least one row in the sessions table tagged with this run's session_id",
  prompt:
    "Reply with the single word 'pong' and nothing else. Do not call any tools.",
  assertions: [
    {
      type: "hook-log-contains",
      substring: "session=",
      label: "hook ran and wrote a session line",
    },
    {
      type: "select-from-db",
      label: "at least one sessions row landed for this session_id",
      // The agent generates its own session_id at startup. The seed in
      // ctx.sessionId is what cleanup falls back to; the truth post-run
      // is run.sessionId, captured by the driver from the hook log.
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%'`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`expected ≥ 1 session row, got ${n}`);
        }
      },
    },
  ],
};

export default captureSmokeCase;
