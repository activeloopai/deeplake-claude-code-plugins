/**
 * Missing-table self-heal — RELEASE_CHECKLIST §6.
 *
 * First INSERT against a missing sessions / memory table should
 * `CREATE TABLE IF NOT EXISTS` lazily and retry. Without this, the very
 * first capture after a fresh workspace setup would fail and silently
 * drop the row.
 *
 * setup() drops the sessions table (best-effort — if it doesn't exist
 * yet, fine). The agent's prompt triggers a normal capture flow. We
 * then assert that the table was recreated AND the post-create INSERT
 * landed.
 *
 * We DROP only the sessions table, not memory, to keep the blast
 * radius small and the case fast. The two paths share the same
 * ensureSessionsTable() helper so coverage transfers.
 *
 * Note: this case is destructive within the e2e workspace by design.
 * The harness uses a dedicated `hivemind_e2e_test` workspace so the
 * DROP has no impact on real data. If it ever ran against a real
 * workspace, that'd be catastrophic — same constraint as every other
 * destructive scenario in RELEASE_CHECKLIST §7.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { CaseContext, E2ECase } from "../types.js";

/**
 * Per-run table name derived from the case's session_id. Using a unique
 * table name (instead of the canonical `sessions`) means this case's
 * destructive DROP doesn't poison the workspace for downstream cases.
 * Prior iteration of this case dropped the shared sessions table, and
 * the schema-drift from the lazy recreate cascaded into 5+ failures in
 * subsequent cases. Per-run isolation eliminates that whole class.
 *
 * sqlIdent allows letters/digits/underscores, so we strip dashes from
 * the runId-bearing session_id.
 */
function perRunSessionsTable(ctx: CaseContext): string {
  return `sessions_e2e_06_${ctx.sessionId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

const missingTableSelfHealCase: E2ECase = {
  id: "06-missing-table-self-heal",
  description:
    "after the sessions table is dropped, the next capture lazily creates it and lands the row",
  prompt:
    "Reply with the single word 'heal' once and stop. Do not call tools.",
  async setup(ctx) {
    // Point this case's agent at a per-run sessions table via env var so
    // the destructive DROP below scopes to THAT table, not the workspace-
    // shared `sessions`. The capture path reads HIVEMIND_SESSIONS_TABLE
    // at hook entry, so setting it here propagates to the spawn the
    // runner makes next.
    const perRunTable = perRunSessionsTable(ctx);
    process.env.HIVEMIND_SESSIONS_TABLE = perRunTable;

    // Drop the per-run table (idempotent — won't exist on a clean run;
    // may exist from a prior run that didn't get cleaned up).
    const api = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      perRunTable,
    );
    try {
      await api.query(`DROP TABLE IF EXISTS "${perRunTable}"`);
    } catch {
      // Best-effort; if the drop fails the assertion still asserts on
      // the row landing, which can only succeed if either the table
      // was already absent (fine) or self-heal recreated it.
    }
  },
  assertions: [
    {
      type: "select-from-db",
      label: "sessions table exists after the run (self-healed)",
      sql: ({ ctx }) =>
        `SELECT count(*) AS n FROM "${perRunSessionsTable(ctx)}"`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("sessions count returned no rows — table never came back");
      },
    },
    {
      type: "select-from-db",
      label: "this run's session_id landed at least one row in the recreated table",
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${perRunSessionsTable(ctx)}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%'`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`expected ≥ 1 row for the run, got ${n} — lazy CREATE TABLE didn't recover`);
        }
      },
    },
    // Cleanup: drop the per-run table AND unset the env var so
    // subsequent cases in the same matrix run aren't affected. We use a
    // `custom` assertion as the teardown vehicle because there's no
    // explicit teardown hook on E2ECase; custom assertions always run
    // after the typed ones and can do filesystem/DB cleanup safely.
    {
      type: "custom",
      label: "teardown — drop the per-run sessions table + restore env",
      check: async ({ ctx }) => {
        const perRunTable = perRunSessionsTable(ctx);
        const api = new DeeplakeApi(
          ctx.creds.token,
          ctx.creds.apiUrl,
          ctx.creds.orgId,
          ctx.creds.workspaceId,
          perRunTable,
        );
        try { await api.query(`DROP TABLE IF EXISTS "${perRunTable}"`); } catch { /* best-effort */ }
        delete process.env.HIVEMIND_SESSIONS_TABLE;
        return null;
      },
    },
  ],
};

export default missingTableSelfHealCase;
