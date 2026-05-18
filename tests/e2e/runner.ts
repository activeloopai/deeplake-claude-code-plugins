#!/usr/bin/env tsx
/**
 * Cross-agent E2E runner.
 *
 * Usage:
 *   tsx tests/e2e/runner.ts                          # run full matrix
 *   tsx tests/e2e/runner.ts --case 01-capture-smoke  # one case, all agents
 *   tsx tests/e2e/runner.ts --agent claude-code      # one agent, all cases
 *   tsx tests/e2e/runner.ts --case X --agent Y       # one point
 *   tsx tests/e2e/runner.ts --keep-sandbox           # leave tmp HOMEs on disk
 *
 * Env vars consumed:
 *   HIVEMIND_E2E_CREDS_JSON    full credentials.json blob for the
 *                              hivemind-e2e workspace. Required.
 *   HIVEMIND_E2E_TABLE_SUFFIX  optional suffix to append to sessions/memory
 *                              table names (default: ""). Useful for local
 *                              dev: HIVEMIND_E2E_TABLE_SUFFIX=$(whoami) so
 *                              two devs running concurrently don't collide.
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY   provider keys
 *                              forwarded to each agent. Missing keys cause
 *                              their agent's points to be skipped (with a
 *                              clear reason in the summary), not failed.
 *
 * Exit code: 0 on all-pass, 1 on any failure, 2 on harness misconfig.
 */

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentDriver,
  CaseContext,
  E2ECase,
  MatrixResult,
  ProviderEnv,
  RunResult,
  TestCredentials,
} from "./types.js";
import { ALL_DRIVERS, buildMatrix, loadAllCases, type MatrixPoint } from "./matrix.js";
import { createSandbox, buildSessionId } from "./sandbox.js";
import { cleanupSessionRows, makeAssertionRunner } from "./assertions.js";
import { writeSummary, formatCents, type RunSummary } from "./cost.js";
import { resolveTestCreds } from "./creds-bootstrap.js";

interface CliArgs {
  case: string | null;
  agent: string | null;
  keepSandbox: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { case: null, agent: null, keepSandbox: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--case" || a === "-c") { out.case = argv[++i] ?? null; continue; }
    if (a === "--agent" || a === "-a") { out.agent = argv[++i] ?? null; continue; }
    if (a === "--keep-sandbox") { out.keepSandbox = true; continue; }
    if (a === "--list") { out.list = true; continue; }
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    // Ignore unknown flags rather than failing — keeps `tsx --inspect …`-
    // style debugger flags from breaking the run.
  }
  return out;
}

function printHelp(): void {
  console.log(`\
hivemind cross-agent e2e runner

Usage:
  tsx tests/e2e/runner.ts [--case <id>] [--agent <id>] [--keep-sandbox] [--list]

Flags:
  --case, -c <id>       Run only this case id (e.g. 01-capture-smoke)
  --agent, -a <id>      Run only this agent id (e.g. claude-code)
  --keep-sandbox        Leave tmp HOMEs on disk after run for debugging
  --list                Print the matrix and exit (no spawns)
  --help, -h            Show this help

Required env:
  HIVEMIND_E2E_CREDS_JSON    full credentials.json for the e2e workspace

Optional env:
  HIVEMIND_E2E_TABLE_SUFFIX  suffix on sessions/memory table names
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY
`);
}

async function loadTestCreds(): Promise<TestCredentials> {
  try {
    return await resolveTestCreds();
  } catch (e: unknown) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function loadProviderEnv(): ProviderEnv {
  return {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
}

function isReady(_agent: AgentDriver, _env: ProviderEnv): { ready: boolean; reason: string | null } {
  // Every supported agent CLI maintains its own auth state (claude via
  // SSO / OAuth, codex via OpenAI login, cursor-agent via Cursor login,
  // hermes via configured provider, pi via gemini auth, openclaw via the
  // gateway's own creds). The harness used to skip when the matching
  // env-var key wasn't exported — but that gate was redundant: if the
  // CLI is logged in, the spawn works without any env var. If it's NOT
  // logged in, the spawn fails with a meaningful error and the case
  // surfaces a real failure (which is what we WANT — silent skips hide
  // the "did anyone test this agent?" question).
  //
  // Drivers still forward env keys when present (see each agent's run()).
  // The runner just no longer pre-gates on them.
  return { ready: true, reason: null };
}

async function runPoint(
  point: MatrixPoint,
  creds: TestCredentials,
  providerEnv: ProviderEnv,
  repoRoot: string,
  runId: string,
  keepSandbox: boolean,
): Promise<MatrixResult> {
  const c: E2ECase = point.case;
  const a: AgentDriver = point.agent;
  if (point.skipped) {
    // Match the provider-key-missing skip's marker shape so the output
    // formatter and summary counter both treat skipFor as a skip, not a
    // pass. Without this marker the point displays as `ok (0ms, $?)` and
    // gets miscounted in the totals.
    return {
      case: c.id,
      agent: a.id,
      passed: true,
      failure: `[skip] declared skipFor: ${a.id}`,
      costCents: null,
      durationMs: 0,
      sessionId: "",
    };
  }
  // installOnly cases never spawn the agent → provider keys are
  // irrelevant. Only gate on the key when we're actually going to
  // run().
  if (!c.installOnly) {
    const ready = isReady(a, providerEnv);
    if (!ready.ready) {
      return {
        case: c.id,
        agent: a.id,
        passed: true, // skip is not a failure
        failure: `[skip] ${ready.reason}`,
        costCents: null,
        durationMs: 0,
        sessionId: "",
      };
    }
  }
  const sandbox = createSandbox(a.id, creds);
  const seedSessionId = buildSessionId(c.id, a.id, runId);
  const ctx: CaseContext = {
    home: sandbox.home,
    sessionId: seedSessionId,
    agent: a.id,
    creds,
  };
  let actualSessionId = seedSessionId;
  const failures: string[] = [];
  let costCents: number | null = null;
  let durationMs = 0;
  try {
    await a.install(sandbox.home, repoRoot);
    if (c.setup) await c.setup(ctx);
    let run: RunResult;
    if (c.installOnly) {
      // Install-shape case: no agent spawn. Assertions read from
      // post-install filesystem / DB state only. We build a dummy
      // RunResult so the assertion vocabulary keeps working — most
      // assertions don't reference run.* fields, and the ones that do
      // (e.g. select-from-db using run.sessionId) get the seed value.
      run = {
        stdout: "",
        stderr: "",
        exitCode: 0,
        sessionId: seedSessionId,
        costCents: 0,
        durationMs: 0,
      };
    } else {
      run = await a.run(c.prompt, {
        home: sandbox.home,
        repoRoot,
        sessionId: seedSessionId,
        providerEnv,
        // 180s spawn budget — empirically 90s isn't enough for pi/hermes
        // cases where the model run, openrouter routing latency, and
        // session-end wiki-worker INSERT all compound. Single-turn
        // claude-code cases still complete in 5-30s; the bigger budget
        // only matters for the slow tail.
        timeoutMs: 180_000,
      });
      if (run.exitCode !== 0) {
        failures.push(`[spawn] exit=${run.exitCode} stderr=${run.stderr.slice(-400)}`);
      }
    }
    actualSessionId = run.sessionId;
    costCents = run.costCents;
    durationMs = run.durationMs;
    const runner = makeAssertionRunner(ctx);
    for (const assertion of c.assertions) {
      const reason = await runner.run(assertion, { ctx, run });
      if (reason) failures.push(reason);
    }
  } catch (e: unknown) {
    failures.push(`[runner threw] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      const cleanup = await cleanupSessionRows(ctx, actualSessionId);
      if (cleanup.error) {
        // Best-effort, not a fail — log it but don't add to failures.
        console.warn(`  [cleanup] ${cleanup.error}`);
      }
    } catch (e: unknown) {
      console.warn(`  [cleanup] threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!keepSandbox) sandbox.destroy();
    if (a.cleanup) {
      try { await a.cleanup(sandbox.home); } catch { /* best-effort */ }
    }
  }
  return {
    case: c.id,
    agent: a.id,
    passed: failures.length === 0,
    failure: failures.length === 0 ? null : failures.join("\n  "),
    costCents,
    durationMs,
    sessionId: actualSessionId,
  };
}

function fail(msg: string): never {
  console.error(`[harness misconfig] ${msg}`);
  process.exit(2);
}

/**
 * Pre-flight: build the bundle if it's missing. The non-claude drivers
 * spawn `node bundle/cli.js <agent> install` to install hivemind into
 * the tmp HOME — a missing bundle blocks every point of the matrix.
 * Auto-building here makes `npm run e2e` a single command from a fresh
 * checkout: no separate `npm run build` step, no "I forgot to build"
 * failures with a confusing per-agent stderr.
 *
 * Honor `HIVEMIND_E2E_SKIP_BUILD=1` to opt out (useful when iterating
 * on the harness itself and the bundle hasn't changed).
 */
function ensureBundleBuilt(repoRoot: string): void {
  if (process.env.HIVEMIND_E2E_SKIP_BUILD === "1") return;
  const bundlePath = resolve(repoRoot, "bundle", "cli.js");
  if (existsSync(bundlePath)) return;
  console.log("⚙ bundle/cli.js missing — running `npm run build`...");
  try {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  } catch (e: unknown) {
    fail(
      `\`npm run build\` failed: ${e instanceof Error ? e.message : String(e)}. ` +
      `Run it manually, then retry \`npm run e2e\`.`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  if (!args.list) ensureBundleBuilt(repoRoot);

  // Filter cases / agents per CLI flags. ALL_CASES is auto-discovered
  // from tests/e2e/cases/*.ts — adding a case is one new file, no
  // matrix.ts edit. See loadAllCases() for discovery rules.
  const ALL_CASES = await loadAllCases();
  const cases = args.case
    ? ALL_CASES.filter((c) => c.id === args.case)
    : ALL_CASES;
  const drivers = args.agent
    ? ALL_DRIVERS.filter((d) => d.id === args.agent)
    : ALL_DRIVERS;
  if (cases.length === 0) fail(`unknown --case=${args.case}; known: ${ALL_CASES.map((c) => c.id).join(", ")}`);
  if (drivers.length === 0) fail(`unknown --agent=${args.agent}; known: ${ALL_DRIVERS.map((d) => d.id).join(", ")}`);
  const matrix = buildMatrix(cases, drivers);

  if (args.list) {
    for (const p of matrix) {
      const tag = p.skipped ? `SKIP (${p.skipReason})` : "—";
      console.log(`${p.case.id}\t${p.agent.id}\t${tag}`);
    }
    return;
  }

  const creds = await loadTestCreds();
  const providerEnv = loadProviderEnv();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startedAt = new Date().toISOString();

  // Run each driver's optional precheck once. Drivers that report not-
  // ready get a single line in the output AND all their points fall
  // through to a clean skip — instead of N copy-paste auth-failure
  // stack traces. Drivers without a precheck (or that return ready)
  // proceed normally.
  const notReadyAgents = new Map<string, string>();
  for (const d of drivers) {
    if (!d.precheck) continue;
    const r = await d.precheck();
    if (!r.ready) {
      notReadyAgents.set(d.id, r.reason);
      console.log(`  precheck ${d.id}: not ready — ${r.reason}`);
    }
  }

  console.log(
    `▶ run ${runId}: ${matrix.length} points across ${drivers.length} agents × ${cases.length} cases\n` +
    `  workspace ${creds.workspaceId} (org ${creds.orgName ?? creds.orgId})`,
  );

  const results: MatrixResult[] = [];
  for (const point of matrix) {
    const label = `${point.case.id} × ${point.agent.id}`;
    process.stdout.write(`  ${label}... `);
    // Honor the precheck verdict: if the agent's precheck reported
    // not-ready, every one of its points is a clean skip — no spawn,
    // no DB churn, one descriptive reason line in the summary.
    const notReadyReason = notReadyAgents.get(point.agent.id);
    if (notReadyReason && !point.skipped) {
      const r: MatrixResult = {
        case: point.case.id,
        agent: point.agent.id,
        passed: true,
        failure: `[skip] ${notReadyReason}`,
        costCents: null,
        durationMs: 0,
        sessionId: "",
      };
      results.push(r);
      console.log(`skip — ${notReadyReason}`);
      continue;
    }
    const r = await runPoint(point, creds, providerEnv, repoRoot, runId, args.keepSandbox);
    results.push(r);
    if (r.failure?.startsWith("[skip]")) {
      console.log(`skip — ${r.failure.slice(7)}`);
    } else if (r.passed) {
      console.log(`ok (${r.durationMs}ms, ${formatCents(r.costCents)})`);
    } else {
      console.log(`FAIL`);
      console.log(`    ${r.failure?.split("\n").join("\n    ")}`);
    }
  }

  const passed = results.filter((r) => r.passed && !r.failure?.startsWith("[skip]")).length;
  const failed = results.filter((r) => !r.passed).length;
  const skipped = results.filter((r) => r.failure?.startsWith("[skip]") || r.failure === `[skip]`).length;
  const totalCostCents = results.reduce((acc, r) => acc + (r.costCents ?? 0), 0);
  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: cases.length,
    totalAgents: drivers.length,
    totalPoints: matrix.length,
    passed,
    failed,
    skipped,
    totalCostCents,
    results,
  };
  const summaryPath = writeSummary(repoRoot, summary);

  console.log("");
  console.log(`◆ ${passed} pass, ${failed} fail, ${skipped} skip · total ${formatCents(totalCostCents)}`);
  console.log(`◆ summary written to ${summaryPath}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`[harness fatal] ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(2);
});
