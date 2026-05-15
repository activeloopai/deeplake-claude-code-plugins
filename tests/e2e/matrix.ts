/**
 * Matrix registry: the agents and cases the harness knows about, plus
 * the cross-product the runner iterates over.
 *
 * Adding a new agent or case is one entry in the lists below — no
 * generic-list import gymnastics. We deliberately keep this as a plain
 * literal array rather than auto-discovery via fs.readdir so that
 * (1) ordering is explicit and predictable, (2) a half-finished file
 * in the cases/ dir doesn't accidentally get picked up.
 */

import type { AgentDriver, E2ECase, AgentId } from "./types.js";
import { claudeCodeDriver } from "./agents/claude-code.js";
import { codexDriver } from "./agents/codex.js";
import { cursorAgentDriver } from "./agents/cursor-agent.js";
import { hermesDriver } from "./agents/hermes.js";
import { piDriver } from "./agents/pi.js";
import { openclawDriver } from "./agents/openclaw.js";
import { captureSmokeCase } from "./cases/01-capture-smoke.js";
import { catIndexMdCase } from "./cases/02-cat-index-md.js";
import { grepMemorySummariesCase } from "./cases/03-grep-memory-summaries.js";
import { sessionStartInjectCase } from "./cases/04-session-start-inject.js";
import { sqlInjectionProbeCase } from "./cases/05-sql-injection-probe.js";
import { missingTableSelfHealCase } from "./cases/06-missing-table-self-heal.js";
import { unicodeRoundtripCase } from "./cases/07-unicode-roundtrip.js";
import { openclawToolsCase } from "./cases/08-openclaw-tools.js";
import { installNoBrokenPathsCase } from "./cases/09-install-no-broken-paths.js";
import { invalidIdentifierRejectionCase } from "./cases/10-invalid-identifier-rejection.js";
import { pathTraversalRejectionCase } from "./cases/11-path-traversal-rejection.js";
import { recursionGuardCase } from "./cases/12-recursion-guard.js";

export const ALL_DRIVERS: AgentDriver[] = [
  claudeCodeDriver,
  codexDriver,
  cursorAgentDriver,
  hermesDriver,
  piDriver,
  openclawDriver,
];

export const ALL_CASES: E2ECase[] = [
  captureSmokeCase,
  catIndexMdCase,
  grepMemorySummariesCase,
  sessionStartInjectCase,
  sqlInjectionProbeCase,
  missingTableSelfHealCase,
  unicodeRoundtripCase,
  openclawToolsCase,
  installNoBrokenPathsCase,
  invalidIdentifierRejectionCase,
  pathTraversalRejectionCase,
  recursionGuardCase,
];

export interface MatrixPoint {
  case: E2ECase;
  agent: AgentDriver;
  /** True when the case explicitly declares it doesn't apply to this agent. */
  skipped: boolean;
  skipReason: string | null;
}

/** Build the (case × agent) cross-product, honoring per-case skip-lists. */
export function buildMatrix(
  cases: E2ECase[] = ALL_CASES,
  drivers: AgentDriver[] = ALL_DRIVERS,
): MatrixPoint[] {
  const out: MatrixPoint[] = [];
  for (const c of cases) {
    const skipFor = new Set<AgentId>(c.skipFor ?? []);
    for (const a of drivers) {
      const skipped = skipFor.has(a.id);
      out.push({
        case: c,
        agent: a,
        skipped,
        skipReason: skipped ? `${c.id} declares skipFor: ${a.id}` : null,
      });
    }
  }
  return out;
}
