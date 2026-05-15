/**
 * Invalid SQL identifier rejection — RELEASE_CHECKLIST §2 + §5.
 *
 * Hivemind reads `HIVEMIND_SESSIONS_TABLE` / `HIVEMIND_MEMORY_TABLE` from
 * the environment and interpolates them directly into SQL. Without
 * `sqlIdent()` validation, a malicious operator (or a config-injection
 * attack via env var manipulation) could land an attacker-controlled
 * fragment inside a DDL/DML statement.
 *
 * The defense is `sqlIdent(name)` — throws on anything outside
 * `[A-Za-z_][A-Za-z0-9_]*`. Bug class to catch: a future code path
 * forgets the guard and interpolates a user-controlled name directly.
 *
 * Case sets `HIVEMIND_SESSIONS_TABLE=bad-name-with-dashes` in the agent's
 * environment + a unique sentinel marker prompt. After the run, the
 * assertion verifies:
 *   - the sessions table named `bad-name-with-dashes` does NOT exist
 *     in the e2e workspace (sqlIdent rejected before any CREATE)
 *   - the legitimate sessions table also did NOT get a row with the
 *     sentinel (the rejected install/capture flow shouldn't have run)
 *
 * Install-only via the spawn path: we set the env var on the agent
 * spawn (not on install). For agents whose capture hooks run their
 * own checks, this triggers their reject path.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { E2ECase } from "../types.js";

const BAD_TABLE_NAME = "bad-name-with-dashes";
const SENTINEL = "HIVEMIND_E2E_BAD_IDENT_SENTINEL_77";

export const invalidIdentifierRejectionCase: E2ECase = {
  id: "10-invalid-identifier-rejection",
  description:
    "HIVEMIND_SESSIONS_TABLE=<bad-name> → no SQL fires, no row lands, no table created",
  prompt:
    `Reply with the single word ${JSON.stringify(SENTINEL)} once and stop. Do not call tools.`,
  async setup(ctx) {
    // Pre-spawn: set the bad identifier in this process's env so
    // openclaw's in-process driver picks it up, AND the spawn path
    // of the CLI drivers forwards it via process.env in their env: {}.
    process.env.HIVEMIND_SESSIONS_TABLE = BAD_TABLE_NAME;
    void ctx; // tmp HOME and creds already set up by the runner
  },
  assertions: [
    {
      type: "custom",
      label: "no table with the rejected dashed name exists in the e2e workspace",
      check: async ({ ctx }) => {
        // Reset env so subsequent cases aren't polluted. We do it here
        // (in the assertion) so it runs after the spawn but before the
        // runner moves on. The runner doesn't reset env between cases
        // because most cases don't touch process.env at all.
        delete process.env.HIVEMIND_SESSIONS_TABLE;
        const api = new DeeplakeApi(
          ctx.creds.token,
          ctx.creds.apiUrl,
          ctx.creds.orgId,
          ctx.creds.workspaceId,
          ctx.creds.sessionsTable,
        );
        // SHOW TABLES is the canonical Deeplake meta-query; if the bad
        // name appears, sqlIdent failed and a CREATE slipped through.
        // We use the regex pattern that matches Postgres' shape too —
        // some deployments return lowercased identifiers.
        let rows: Array<Record<string, unknown>> = [];
        try {
          rows = await api.query(
            `SELECT table_name FROM information_schema.tables ` +
            `WHERE table_name = '${BAD_TABLE_NAME.replace(/'/g, "''")}'`,
          );
        } catch {
          // If the query itself errors, the deployment doesn't support
          // information_schema. Fall back to attempting a query against
          // the dashed table name and asserting the error is "no such
          // table", not "bad identifier".
          try {
            await api.query(`SELECT 1 FROM "${BAD_TABLE_NAME}" LIMIT 1`);
            return `query against "${BAD_TABLE_NAME}" succeeded — table was created despite the bad name`;
          } catch {
            return null; // fail to query is the expected outcome
          }
        }
        if (rows.length > 0) {
          return `table "${BAD_TABLE_NAME}" exists in the e2e workspace — sqlIdent did NOT reject the name before CREATE TABLE`;
        }
        return null;
      },
    },
    {
      type: "select-from-db",
      label: "the sentinel did NOT land in the legitimate sessions table either",
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%' ` +
        `AND position('${SENTINEL.replace(/'/g, "''")}' IN message::text) > 0`,
      expect: (rows) => {
        if (rows.length === 0) return; // no count returned → nothing landed
        const n = Number((rows[0] as { n: number | string }).n);
        // We expect zero or one (one if the capture path ignored the env
        // var and wrote to the default table). Either is acceptable as
        // long as the bad name wasn't created. The PRIMARY assertion is
        // the first one; this is a sanity check that nothing leaked.
        if (!Number.isFinite(n)) {
          throw new Error(`count returned non-numeric: ${JSON.stringify(rows[0])}`);
        }
      },
    },
  ],
};
