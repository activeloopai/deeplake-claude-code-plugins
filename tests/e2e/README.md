# Cross-agent E2E matrix (tier 1)

This directory drives the five headless agent CLIs we support — claude-code, codex, cursor-agent, hermes, pi — through real prompts against a real Deeplake workspace, and asserts on real side effects (DB rows, hook log lines, captured stdout, inject text). It's the layer that catches plugin bugs that source + bundle tests can't, like:

- a hook bundle that imports correctly but throws at runtime under one agent's loader,
- a per-agent install path that drifted out of sync with the runtime expectation,
- a cross-agent inconsistency where claude-code returns the synthesized index but cursor-agent ENOENTs.

The matrix is **(plugin behavior × agent runtime)**. Add a new shipped behavior → add one case file → it's automatically asserted against all five agents.

Cursor IDE GUI inside the Snap sandbox and OpenClaw gateway live in tier 2 — separate infra, separate matrix (`tests/e2e-tier2/`, not built yet). Issues that only show up in those runtimes are flagged in the case docstring with `skipFor`.

## Running it

### Locally

```bash
# One full pass of all cases × all agents — ~10 minutes, ~$1.50 in API
npm run e2e

# Single case across all agents
npm run e2e -- --case 02-cat-index-md

# Single agent across all cases
npm run e2e -- --agent claude-code

# Single point — fastest dev loop
npm run e2e -- --case 01-capture-smoke --agent claude-code

# Print the matrix without spawning anything
npm run e2e -- --list

# Leave tmp HOMEs on disk for inspection
npm run e2e -- --keep-sandbox
```

Test workspace resolution is **automatic** — two modes, evaluated in order:

1. **CI / explicit** (`HIVEMIND_E2E_CREDS_JSON` env var is set): the value is parsed as a full credentials.json blob. Highest priority; no API lookup. This is how CI runs it.
2. **Local / derive from operator** (default for devs): the harness reads your `~/.deeplake/credentials.json`, keeps the token + orgId, and resolves a fresh workspaceId by **name** from the workspace named `hivemind_e2e_test` (override with `HIVEMIND_E2E_WORKSPACE_NAME`). Your real credentials.json is **read-only** — the harness never calls `hivemind workspace <id>` or otherwise persists a workspace switch, so a mid-run crash can't leave you on the wrong workspace.

If both fail (no creds blob AND no logged-in operator AND no matching workspace), the runner exits 2 with a clear message describing what's missing.

Other env vars:

- `ANTHROPIC_API_KEY` — needed for claude-code's points (others skip cleanly).
- `OPENAI_API_KEY` — needed for codex + cursor-agent.
- `GOOGLE_API_KEY` — needed for hermes + pi.
- `HIVEMIND_E2E_WORKSPACE_NAME` — override the default `hivemind_e2e_test` workspace name (mode 2 only).
- `HIVEMIND_E2E_TABLE_SUFFIX` — appended to sessions/memory table names. Use `HIVEMIND_E2E_TABLE_SUFFIX=$(whoami)` locally so two devs running concurrently don't collide on the same row paths.

A missing provider key results in a **skip** (not a failure) for that agent's points, with the reason printed inline. The exit code stays 0 unless an actually-run point fails an assertion.

### One-time setup (local mode)

1. `hivemind login` against the org that owns the `hivemind_e2e_test` workspace.
2. Confirm `hivemind workspaces` shows `hivemind_e2e_test` in the list. If it doesn't, ask an admin to create it. Don't run e2e against your real working workspace — the harness DELETEs rows by session_id on cleanup and that's catastrophic for a real workspace.
3. Run `npm run e2e -- --list` to confirm the harness picks up the matrix. Then `npm run e2e -- --case 01-capture-smoke --agent claude-code` for the fastest live smoke.

### One-time setup (CI mode)

1. Provision the `hivemind_e2e_test` workspace as above.
2. Generate a credentials.json blob pointed at it (e.g. via `hivemind login` on a throwaway machine).
3. Save the blob as the `HIVEMIND_E2E_CREDS_JSON` GH secret, plus the provider keys as `HIVEMIND_E2E_ANTHROPIC_API_KEY` etc.

### In CI

Trigger `.github/workflows/e2e.yml` manually from the GitHub Actions tab, optionally with the `case_filter` / `agent_filter` inputs. There is **no schedule and no PR trigger** — every run costs money and burns ~10 minutes; we run it as a release-readiness gate, not as a per-PR gate. The unit/source/bundle tests in `npm test` keep gating merges.

## How a case works

Each file in `cases/` exports one `E2ECase` object:

```ts
export const myCase: E2ECase = {
  id: "05-my-behavior",
  description: "what this case asserts about the plugin",
  prompt: "instruct the agent to do something that exercises the hook",
  // optional: seed test data the agent will retrieve
  async setup(ctx) {
    // ctx.creds is a configured DeeplakeApi target
    // ctx.sessionId is unique to this (case, agent, runId)
  },
  assertions: [
    { type: "hook-log-contains", substring: "what the hook logs when this fires" },
    { type: "stdout-contains", substring: "what the agent says when it works" },
    {
      type: "select-from-db",
      sql: ({ ctx, run }) => `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" WHERE path ILIKE '%${run.sessionId}%'`,
      expect: (rows) => { if (Number(rows[0].n) < 1) throw new Error("no rows"); },
    },
  ],
  // optional: this case doesn't apply to these agents (rationale required)
  skipFor: ["pi"], // pi doesn't ship the X bundle; tracked in #NNN
};
```

Then register it in `matrix.ts`:

```ts
import { myCase } from "./cases/05-my-behavior.js";
export const ALL_CASES: E2ECase[] = [..., myCase];
```

That's the entire change. The harness handles sandboxing, install, spawn, cleanup, and reporting for all five agents.

## How a driver works

Each file in `agents/` exports one `AgentDriver` object:

```ts
export const myAgentDriver: AgentDriver = {
  id: "my-agent",
  async install(home, repoRoot) {
    // copy the bundle into <home>/<agent-path>, write any config file
  },
  async run(prompt, opts) {
    // spawn the real CLI with HOME=opts.home + HIVEMIND_DEBUG=1
    // forward opts.providerEnv to the spawn env
    // return { stdout, stderr, exitCode, sessionId, costCents, durationMs }
  },
};
```

Drivers are 50–80 lines each. `runProcess` in `agents/claude-code.ts` is exported and reusable — most drivers just compose the right argv + env and delegate.

Assertions are **not** a driver concern. Drivers don't know what the case wants; they just spawn and capture.

## How session_id flows

1. Harness generates a deterministic **seed** session_id `e2e-<runId>-<case>-<agent>` (see `sandbox.ts:buildSessionId`).
2. The seed goes into the spawn so cleanup can find rows even if the agent didn't print its own session_id.
3. The agent generates its own UUID session_id at start. Driver reads it from `hook-debug.log` via the `session=<uuid>` line every hivemind hook writes.
4. Assertions use `run.sessionId` (the real one).
5. Cleanup uses `run.sessionId` (or falls back to the seed if discovery failed).

## How cleanup works

After each case:

1. Runner calls `cleanupSessionRows(ctx, run.sessionId)` — DELETEs from `sessions` + `memory` where path ILIKE `%<sid>%`.
2. The tmp HOME is rm-rf'd unless `--keep-sandbox` was passed.
3. Cleanup failures are warned but **don't fail the case** — a leftover row is a small workspace-debris cost, not a signal we want to gate on.

A daily cron in the test workspace sweeps `WHERE creation_date < now() - interval '24h' AND agent ILIKE 'e2e-%'` as belt-and-suspenders against killed runs.

## Why this isn't run on every PR

Three reasons:

1. **Cost** — every run is ~$1.50 in provider API calls. PR-gating × dozens of PRs/day = real money.
2. **Flake surface** — upstream agent CLIs change flag shapes between minor releases. A PR unrelated to e2e would gate-fail because hermes 1.4.3 renamed `--yolo`.
3. **Wall time** — ~10 minutes vs the current 23-second `npm test`. Slows the merge loop for marginal incremental value (most regressions also surface in unit tests).

Once we have a week of stable nightly runs and a flake budget < 5%, we can promote to PR-gating with a path filter on `src/hooks/**` etc. (separate PR.)

## What this matrix does NOT cover

- **OpenClaw gateway** — tier 2 (no `openclaw -p <prompt>` CLI).
- **Cursor IDE GUI inside Snap** — tier 2 (issue-class that only shows up under the Snap sandbox; needs a long-lived test VM).
- **Pure source-level logic** — tests that don't actually need an agent runtime stay as vitest unit tests in `claude-code/tests/`. Don't pad the matrix with cases the agent runtime adds no signal to.
- **Model-quality regression** — we test what the *plugin* does, not what the model says. Asserting "agent gave a good answer" is out of scope; that's a separate evaluation problem with a separate tool.

## Adding tier-2 cases

Don't put them here. Create `tests/e2e-tier2/` with the same matrix shape (driver + case + runner). Tier 2 needs separate infrastructure (long-lived VM, Xvfb, tmux for OpenClaw) and we don't want it gating the tier-1 invocation surface.
