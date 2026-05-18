# Cross-agent E2E matrix

This directory drives **all six** agent runtimes hivemind supports — claude-code, codex, cursor-agent, hermes, pi, openclaw — through real prompts against a real Deeplake workspace, and asserts on real side effects (DB rows, hook log lines, captured stdout, inject text, tool-call results). It's the layer that catches plugin bugs that source + bundle tests can't, like:

- a hook bundle that imports correctly but throws at runtime under one agent's loader,
- a per-agent install path that drifted out of sync with the runtime expectation,
- a cross-agent inconsistency where claude-code returns the synthesized index but cursor-agent ENOENTs,
- a SQL escape bug in capture that silently corrupts unicode content on JSONB roundtrip,
- a missing-table self-heal regression that drops the very first capture after a fresh workspace setup.

The matrix is **(plugin behavior × agent runtime)**. Add a new shipped behavior → add one case file → it's automatically asserted against every applicable agent.

## Agent shapes (not all six are CLIs)

| Agent | Driver shape | How `run()` works |
|---|---|---|
| claude-code | subprocess | `claude -p --plugin-dir <bundle> --allowedTools ...` |
| codex | subprocess | `codex exec -m gpt-5-mini <prompt>` |
| cursor-agent | subprocess | `cursor-agent --print --force --model gpt-5-mini` |
| hermes | subprocess | `hermes -z <prompt> --provider google --yolo` |
| pi | subprocess | `pi --print --provider google --model gemini-2.5-flash` |
| **openclaw** | **programmatic** | OpenClaw is a gateway, not a CLI. Driver loads the installed plugin module from `~/.openclaw/extensions/hivemind/dist/index.js`, provides a fake `pluginApi` that captures registered handlers + tools, then fires synthetic events (`agent_end` for capture cases) or invokes registered tools directly (`hivemind_search` / `hivemind_read` for tool cases). Plugin code paths run end-to-end — only the gateway's own event parsing / multi-event ordering / concurrency are out of scope (covered by openclaw's own tests, not ours). |

## Case coverage map

Each case asserts on a specific behavioral surface, mapped back to `RELEASE_CHECKLIST.md`:

| Case | Surface | Applies to | Skipped on (reason) |
|---|---|---|---|
| `01-capture-smoke` | One turn → one row in sessions (checklist §2 happy path) | all 6 | — |
| `02-cat-index-md` | `cat ~/.deeplake/memory/index.md` → virtual index (§4 discoverability via Read) | 5 CLI | openclaw (no bash; equivalent via `hivemind_read` in case 08) |
| `03-grep-memory-summaries` | `grep` routes through SQL fast-path with seeded sentinel (§4 search) | 5 CLI | openclaw (no bash; equivalent via `hivemind_search` in case 08) |
| `04-session-start-inject` | 3-tier text visible in agent context (§4 SessionStart inject) | 5 CLI | openclaw (different mechanism via openclaw/skills/SKILL.md) |
| `05-sql-injection-probe` | Injection payload doesn't drop the memory table (§5 SQL identifiers + strings) | all 6 | — |
| `06-missing-table-self-heal` | Lazy CREATE TABLE IF NOT EXISTS on first INSERT after drop (§6 backend quirks) | all 6 | — |
| `07-unicode-roundtrip` | Emoji + RTL + smart quotes + backslashes survive JSONB roundtrip byte-for-byte (§2 edge content) | all 6 | — |
| `08-openclaw-tools` | `hivemind_search` returns seeded sentinel via openclaw tool registration (§3 openclaw row + §4 openclaw discoverability) | openclaw | 5 CLI (they don't register MCP tools the harness invokes directly; equivalents in 02/03) |
| `09-install-no-broken-paths` | After `hivemind <agent> install`, every hook command in the resulting config file points at a file that exists on disk. Plus claude-code-only auto-heal check: pre-seeded broken entry was removed by `cleanupBrokenSettingsHooks`. Install-shape (no agent spawn). | 4 hooks-config agents | pi (TS extension ref, no command paths) / openclaw (gateway loader, no hooks.json) |
| `10-invalid-identifier-rejection` | `HIVEMIND_SESSIONS_TABLE=bad-name-with-dashes` → `sqlIdent()` rejects → no SQL fires → no `bad-name-with-dashes` table exists in workspace afterward (§2 + §5 SQL identifiers) | all 6 | — |
| `11-path-traversal-rejection` | `cat ~/.deeplake/memory/../../../../etc/passwd` → virtual mount rewrite rejects/blocks; agent's stdout does NOT contain `/etc/passwd` shape `root:x:0:0:` (§5 path traversal) | 5 CLI | openclaw (different tool-arg validation path; would need a dedicated case) |
| `12-recursion-guard` | `HIVEMIND_WIKI_WORKER=1` pre-set in agent env → session-end wiki worker short-circuits → no summary row lands in memory table (§5 recursion guards) | 5 CLI | openclaw (in-band worker, different pattern) |

Total: **72 matrix points** (60 live, 12 explicitly skipped with rationale).

### Why case 09 matters specifically

Case 09 is the matrix's answer to a destructive hotfix that shipped to npm: PR #128 added a `syncHivemindHooksToSettings()` helper that wrote hardcoded path entries into `~/.claude/settings.json` for marketplace-only users — every hook ENOENT'd at session start. Shipped in 0.7.23 / 0.7.24, hotfixed in PR #166. Case 09 runs the real `hivemind <agent> install` flow in a clean tmp HOME and walks the resulting config: any command pointing at a nonexistent file fails the assertion. Plus the claude-code-only auto-heal sub-assertion pre-seeds a known-broken entry and verifies `cleanupBrokenSettingsHooks` removed it.

Earlier cases (`01-capture-smoke` etc.) didn't catch this because the claude-code driver uses `claude --plugin-dir` for runtime cases — that bypasses the install flow entirely. Case 09 is install-shape (`installOnly: true`) and triggers the real installer subprocess to exercise the path PR #128 broke.

## Running it

**Steady state: one command.**

```bash
npm run e2e
```

That's it. The runner auto-resolves credentials (operator's logged-in state or `HIVEMIND_E2E_CREDS_JSON`), auto-builds `bundle/cli.js` if it's missing, auto-skips any agent with a missing provider key, and DELETEs the rows it wrote before exiting. No separate `npm install` / `npm run build` / "did I switch workspace?" steps.

**Other invocations:**

```bash
# Print the matrix without spawning anything (free, no creds needed)
npm run e2e -- --list

# Single case across all agents — narrow the blast radius
npm run e2e -- --case 02-cat-index-md

# Single agent across all cases
npm run e2e -- --agent claude-code

# Single point — fastest dev loop, ~$0.01-0.05
npm run e2e -- --case 01-capture-smoke --agent claude-code

# Leave tmp HOMEs on disk for inspection
npm run e2e -- --keep-sandbox

# Skip the auto-build (when iterating on the harness itself and the bundle is current)
HIVEMIND_E2E_SKIP_BUILD=1 npm run e2e
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
- `HIVEMIND_E2E_TABLE_SUFFIX` — appended to sessions/memory table names (e.g. `sessions_<suffix>`). Use this only if the e2e workspace deliberately has per-dev tables; concurrent runs do NOT collide on row paths because every session_id embeds a unique runId timestamp (see `sandbox.ts:buildSessionId`).

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

**Cases are auto-discovered.** Drop a new file in `tests/e2e/cases/` and the next `npm run e2e` runs it against every applicable agent — no `matrix.ts` edit, no registration step.

Each case file exports one `E2ECase` object as its **default export**:

```ts
// tests/e2e/cases/13-my-behavior.ts
import type { E2ECase } from "../types.js";

const myCase: E2ECase = {
  id: "13-my-behavior",
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
    // Escape hatch for assertions that don't fit the four typed shapes
    // (filesystem checks, per-agent config walks, etc.):
    { type: "custom", label: "X", check: async ({ ctx, run }) => null /* or failure string */ },
  ],
  // optional: this case doesn't apply to these agents (rationale required)
  skipFor: ["pi"], // pi doesn't ship the X bundle; rationale here
  // optional: install-shape case — runner skips driver.run() and goes
  // straight from setup() to assertions. No model API call.
  installOnly: false,
};

export default myCase;
```

**Discovery rules:**

- File lives directly under `tests/e2e/cases/` (no nesting).
- File name ends in `.ts` and starts with a digit (`13-foo.ts`) so it sorts deterministically.
- File MUST `export default` the case object.
- The default export MUST satisfy the `E2ECase` shape (id, prompt, assertions[]).

Files that don't satisfy the rules are silently skipped with a one-line stderr warning — a half-written case in the directory won't break the matrix.

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

## Coverage today + growth target

The matrix ships with **8 cases** covering each major behavioral surface in `RELEASE_CHECKLIST.md` §2 / §3 / §4 / §5 / §6 that an e2e harness can deterministically assert on. As new features ship, **every new behavioral surface should add a case** — adding one is one file in `tests/e2e/cases/` + one line in `matrix.ts`; the matrix runs it against every applicable agent automatically.

A new behavior without a matrix case is the same situation as a new code path without a unit test — fine for a one-off, a slow leak in coverage at scale.

### What the matrix does NOT cover (and shouldn't)

Some checklist items aren't e2e-deterministic by nature:

- **§6 UPDATE coalescing** — two rapid UPDATEs on the same row drop one silently with `row_count: 0`. Reproducing this in a deterministic test requires precise timing in a single connection; covered by unit tests around the affected helpers, not the agent runtime.
- **§3 async hook completion timing** — `claude -p` doesn't block on the Stop hook, so post-exit async work can be killed mid-flight. Asserting on "the row landed *after* the parent exited" is a race that doesn't reliably reproduce on CI hardware. Best handled at source level with timing-aware fakes.
- **§3 per-agent CLI dispatch model name** — "did claude get `haiku-3-5` and codex get `gpt-5-codex-mini`" is a dispatch-config check, not a runtime assertion. Covered by source tests that scan the agent's argv.
- **§1 / §8 unit + bundle scans** — by design, those are the `npm test` layer's job. The e2e matrix is for cross-agent runtime behavior, not bundle byte-checks.

These are documented here so future contributors don't add a brittle case for a problem unit tests can solve more reliably.

## Why this isn't run on every PR (yet)

Three reasons stand today:

1. **Cost** — every run is ~$1.50 in provider API calls at 4 cases × 5 agents. PR-gating × dozens of PRs/day = real money.
2. **Flake surface** — upstream agent CLIs change flag shapes between minor releases. A PR unrelated to e2e would gate-fail because hermes 1.4.3 renamed `--yolo`.
3. **Wall time** — ~10 minutes at current case count vs the 23-second `npm test`. Slows the merge loop for marginal incremental value while coverage is thin.

**Promotion criteria.** When the matrix has (a) stable coverage across a week of clean manual runs, (b) at least one case per major behavioral surface, and (c) a flake budget < 5% over that week, promote the workflow trigger from `workflow_dispatch` to PR-gating with a path filter on `src/hooks/**` / `openclaw/src/**` / bundle outputs. Mirrors how `npm test` + coverage thresholds gate today; the matrix becomes the equivalent gate for cross-agent behavior. That promotion lives in its own PR, with the cadence flip documented in the cost summary of a representative week of nightlies.

Until then, run it manually before any release — the harness is the canonical replacement for the multi-hour cross-agent test pass.

## What this matrix does NOT cover

- **Cursor IDE GUI inside Snap** — a fundamentally different runtime (graphical session, snap sandbox); needs a long-lived test VM + Xvfb. Out of scope for an in-repo harness. Bugs that only surface in the GUI runtime (cursor-snap detached spawns, GUI-only auth flows) belong in a separate manual or VM-based pipeline.
- **Pure source-level logic** — tests that don't actually need an agent runtime stay as vitest unit tests in `claude-code/tests/`. Don't pad the matrix with cases the agent runtime adds no signal to (see "What the matrix does NOT cover" earlier in this doc for specific examples).
- **Model-quality regression** — we test what the *plugin* does, not what the model says. Asserting "agent gave a good answer" is out of scope; that's a separate evaluation problem with a separate tool.

## OpenClaw driver caveats

The openclaw driver loads the installed plugin module and fires events programmatically rather than spinning up a real gateway. What this exercises:

- Hook handler code (`agent_end` capture, `before_prompt_build` inject, etc.) end-to-end against the real Deeplake API.
- Plugin tool registration and `execute()` paths (`hivemind_search`, `hivemind_read`, `hivemind_index`).
- Install-side surface (the plugin lands at the expected path with the expected files).

What it doesn't exercise:

- The gateway's own event parser (the way upstream agent_end payloads are deserialized).
- Multi-event ordering across concurrent sessions.
- Real gateway lifecycle (boot, ready signal, shutdown).

Those gateway-side concerns have their own tests in the openclaw repo. If a future bug class lives specifically in the gateway↔plugin seam, add a dedicated case here that spawns the gateway as a subprocess — the harness is structured to accept that without changing its public shape.
