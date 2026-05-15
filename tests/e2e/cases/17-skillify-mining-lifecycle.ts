/**
 * Skillify mining lifecycle: session → wiki-worker spawn → skill mined.
 *
 * The auto-pull case (16) covers the consumer side — given a skill row
 * exists, can the agent pull it. This case covers the PRODUCER side:
 * given an agent session that exhibits a mineable pattern, does the
 * wiki-worker actually fire after session-end, run the gate, and write
 * a skills row.
 *
 * Full flow under test:
 *   1. Agent has a session with at least N user prompts (the mining
 *      threshold; varies by trigger config).
 *   2. session-end fires the skillify-worker subprocess.
 *   3. The worker pulls the session rows from the sessions table,
 *      builds gate input, invokes the agent CLI as a gate, parses the
 *      gate verdict, and (if KEEP) writes a skills row.
 *
 * Asserting the full pattern requires the gate to verdict KEEP, which
 * requires an LLM call inside the worker. That's the case's API spend.
 *
 * We use the LIGHTEST possible signal that the pipeline ran end-to-end:
 *
 *   - hook-debug.log contains 'skillify-worker' marker (worker did spawn)
 *
 * We do NOT assert "a skills row landed" because the gate may verdict
 * SKIP on a short conversation and we don't want to flake on that
 * judgment call. Mining-as-a-decision is upstream of mining-as-a-
 * pipeline; the pipeline is what this case asserts on.
 *
 * Skipped on openclaw (different worker spawn path — its skillify
 * worker fires from agent_end, not from a separate session-end hook).
 * Covered for openclaw by source-level tests in tests/openclaw/.
 */

import type { E2ECase } from "../types.js";

const skillifyMiningLifecycleCase: E2ECase = {
  id: "17-skillify-mining-lifecycle",
  description:
    "session-end → skillify-worker subprocess fires → hook-debug.log records the spawn",
  // Slightly richer prompt so the session has multiple captures and the
  // mining trigger threshold can fire. Three user turns minimum is the
  // typical floor for any of the trigger heuristics to engage.
  prompt:
    "Tell me three short facts about the moon, one sentence each. " +
    "Don't call tools. Then say 'done'.",
  assertions: [
    {
      type: "hook-log-contains",
      substring: "skillify",
      label: "skillify-worker spawn line present in hook-debug.log post-run",
    },
  ],
  // OpenClaw fires its skillify worker from agent_end (in-band with the
  // gateway), not from a session-end hook. Different spawn topology;
  // unit-tested in tests/openclaw/auto-recall.test.ts.
  skipFor: ["openclaw"],
};

export default skillifyMiningLifecycleCase;
