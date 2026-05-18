/**
 * Worker recursion guard — RELEASE_CHECKLIST §5.
 *
 * Hivemind workers (wiki-worker, skillify-worker) spawn agent CLIs to
 * run gating prompts. Each worker entry point checks an env-var guard
 * (`HIVEMIND_WIKI_WORKER=1`, `HIVEMIND_SKILLIFY_WORKER=1`) at the top
 * and short-circuits if set — otherwise a worker invoked by another
 * worker would recursively spawn forever, exhausting fork bombs.
 *
 * Case: pre-set `HIVEMIND_WIKI_WORKER=1` in the agent's environment.
 * Run a normal turn. Assertion: the wiki worker's session-end-triggered
 * spawn DOES NOT fire (no second worker process appears, no wiki summary
 * lands in the memory table).
 *
 * The signal is "absence of a wiki summary row that the un-guarded
 * version of the worker would have written". Because session-end is
 * also where capture rows finalize, we still expect the sessions row
 * (case 01's assertion), but NOT a memory/summary row for this session.
 *
 * Cost: one full agent turn; same as the other behavioral cases.
 */

import type { E2ECase } from "../types.js";

const recursionGuardCase: E2ECase = {
  id: "12-recursion-guard",
  description:
    "HIVEMIND_WIKI_WORKER=1 in env → session-end wiki worker short-circuits and no summary row lands",
  prompt:
    "Reply with the single word 'guarded' and stop. Do not call tools.",
  async setup(_ctx) {
    // Pre-spawn: set the guard so the agent's session-start /
    // session-end hooks see it as if they were already inside a worker.
    // Reset is done in the assertion (after assertions run) so concurrent
    // cases aren't polluted. The runner doesn't reset env between cases.
    process.env.HIVEMIND_WIKI_WORKER = "1";
  },
  assertions: [
    {
      type: "select-from-db",
      label: "no wiki summary row was written for this session (worker correctly short-circuited)",
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.memoryTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%' ` +
        `AND description ILIKE '%summary%'`,
      expect: (rows) => {
        if (rows.length === 0) return; // no rows means clean pass
        const n = Number((rows[0] as { n: number | string }).n);
        if (Number.isFinite(n) && n > 0) {
          throw new Error(
            `${n} wiki-summary row(s) landed despite HIVEMIND_WIKI_WORKER=1 ` +
            `— recursion guard did not short-circuit the session-end worker spawn`,
          );
        }
      },
    },
    {
      // Reset the env var after assertions so the next case's spawn
      // doesn't inherit the guard. Wrapping in a no-op `custom`
      // assertion is the cleanest hook the runner provides.
      type: "custom",
      label: "env-var cleanup (always passes)",
      check: async () => {
        delete process.env.HIVEMIND_WIKI_WORKER;
        return null;
      },
    },
  ],
  // OpenClaw's plugin loader doesn't spawn workers as separate processes
  // — its skillify worker runs in-band via `realSpawn` from the plugin's
  // own register(). The env-var guard pattern doesn't apply the same way;
  // a dedicated openclaw recursion test would need a different shape.
  skipFor: ["openclaw"],
};

export default recursionGuardCase;
