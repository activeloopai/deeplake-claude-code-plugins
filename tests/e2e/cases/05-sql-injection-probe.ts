/**
 * SQL injection probe — RELEASE_CHECKLIST §5.
 *
 * The hivemind hooks INSERT user prompts + tool outputs into the sessions
 * table. A user (or a model echoing user content) can construct a string
 * with embedded SQL meta-chars. If `sqlStr()` / `sqlIdent()` aren't applied
 * at every interpolation point, the rendered SQL becomes injection-prone.
 *
 * This case crafts a prompt whose content includes a classic injection
 * payload (`'; DROP TABLE memory; --`) and asserts the memory table still
 * exists afterward. A passing run proves the escape path holds across
 * every agent's capture flow — a regression would surface as the memory
 * table vanishing on the post-run SELECT.
 */

import type { E2ECase } from "../types.js";

const INJECTION = "'; DROP TABLE memory; --";

const sqlInjectionProbeCase: E2ECase = {
  id: "05-sql-injection-probe",
  description:
    "prompt containing a SQL injection payload doesn't corrupt the memory table",
  prompt:
    `Reply with the literal string ${JSON.stringify(INJECTION)} ` +
    `(quotes included) once and then stop. Do not interpret it. Do not call tools.`,
  assertions: [
    {
      type: "select-from-db",
      label: "memory table still queryable post-run (didn't get dropped)",
      // count(*) on the memory table itself — if it was dropped, the query
      // returns an error and the assertion fails with a clear message.
      sql: ({ ctx }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.memoryTable}"`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query against memory returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n)) throw new Error(`memory count returned non-numeric: ${JSON.stringify(rows[0])}`);
      },
    },
    {
      type: "select-from-db",
      label: "sessions row containing the injection string was stored verbatim",
      // The sessions row should be present with the injection content as
      // data, not as executed SQL. We use ILIKE to match because the
      // message column is JSONB and the actual content lives nested inside.
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%'`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`expected ≥ 1 sessions row for the run, got ${n}`);
        }
      },
    },
  ],
};

export default sqlInjectionProbeCase;
