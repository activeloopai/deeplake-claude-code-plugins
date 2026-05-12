#!/usr/bin/env tsx
/**
 * Tier-1 cross-agent E2E runner.
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
import { fileURLToPath } from "node:url";
import type {
  AgentDriver,
  CaseContext,
  E2ECase,
  MatrixResult,
  ProviderEnv,
  TestCredentials,
} from "./types.js";
import { ALL_CASES, ALL_DRIVERS, buildMatrix, type MatrixPoint } from "./matrix.js";
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
hivemind tier-1 e2e runner

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

function isReady(agent: AgentDriver, env: ProviderEnv): { ready: boolean; reason: string | null } {
  // Conservative gating: each driver needs its provider's key. We could
  // be more permissive (e.g. cursor-agent + hermes can use multiple
  // providers) but the default models we use are specific.
  switch (agent.id) {
    case "claude-code":
      return env.ANTHROPIC_API_KEY ? { ready: true, reason: null } : { ready: false, reason: "ANTHROPIC_API_KEY not set" };
    case "codex":
    case "cursor-agent":
      return env.OPENAI_API_KEY ? { ready: true, reason: null } : { ready: false, reason: "OPENAI_API_KEY not set" };
    case "hermes":
    case "pi":
      return env.GOOGLE_API_KEY ? { ready: true, reason: null } : { ready: false, reason: "GOOGLE_API_KEY not set" };
  }
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
    return { case: c.id, agent: a.id, passed: true, failure: null, costCents: null, durationMs: 0, sessionId: "" };
  }
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
    const run = await a.run(c.prompt, {
      home: sandbox.home,
      repoRoot,
      sessionId: seedSessionId,
      providerEnv,
      timeoutMs: 90_000,
    });
    actualSessionId = run.sessionId;
    costCents = run.costCents;
    durationMs = run.durationMs;
    if (run.exitCode !== 0) {
      failures.push(`[spawn] exit=${run.exitCode} stderr=${run.stderr.slice(-400)}`);
    }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");

  // Filter cases / agents per CLI flags.
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
  console.log(
    `▶ run ${runId}: ${matrix.length} points across ${drivers.length} agents × ${cases.length} cases\n` +
    `  workspace ${creds.workspaceId} (org ${creds.orgName ?? creds.orgId})`,
  );

  const results: MatrixResult[] = [];
  for (const point of matrix) {
    const label = `${point.case.id} × ${point.agent.id}`;
    process.stdout.write(`  ${label}... `);
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
