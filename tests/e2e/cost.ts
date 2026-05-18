/**
 * Cost tracking + per-run summary writer.
 *
 * Each agent CLI prints its own cost / token usage line in a different
 * format. We parse them best-effort — `null` is an acceptable result and
 * the runner doesn't fail the case on a missing cost. The point is to
 * surface a per-matrix-run cost roll-up so we can see "this case is
 * burning $0.20 per run, can we trim its prompt" without instrumenting
 * each agent ourselves.
 *
 * Patterns are intentionally loose. Brittle parsers waste maintenance
 * time on something that doesn't gate pass/fail.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, MatrixResult } from "./types.js";

/**
 * Try to extract a USD cost from an agent's stdout. Returns cost in cents
 * (integer) or null if no recognizable pattern was found.
 *
 * Per-agent patterns (approximate — agents change these between versions):
 *   claude   : `Cost: $0.0123 USD` or `Total cost: $0.0123 (...)`
 *   codex    : `tokens used: ... cost: $0.0123`
 *   cursor   : no consistent cost line — null
 *   hermes   : same — null
 *   pi       : `Total cost: $0.0123`
 */
export function parseCostCents(agent: AgentId, stdout: string): number | null {
  // Try the agent-specific patterns first, then a generic fallback.
  const patterns: RegExp[] = (() => {
    switch (agent) {
      case "claude-code":
        return [/Total cost:\s*\$([0-9]+\.[0-9]+)/, /Cost:\s*\$([0-9]+\.[0-9]+)/];
      case "codex":
        return [/cost:\s*\$([0-9]+\.[0-9]+)/i];
      case "pi":
        return [/Total cost:\s*\$([0-9]+\.[0-9]+)/];
      case "cursor-agent":
      case "hermes":
        return [];
      case "openclaw":
        // OpenClaw driver fires plugin code directly with no model call,
        // so there's no cost line to parse. Driver hard-codes costCents=0
        // and never invokes this helper, but the case is here for
        // exhaustiveness.
        return [];
    }
  })();
  // Generic fallback that any agent might happen to print.
  patterns.push(/\$([0-9]+\.[0-9]+)\s*(?:USD|usd)?\s*\(/);
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) {
      const dollars = parseFloat(m[1]);
      if (Number.isFinite(dollars)) return Math.round(dollars * 100);
    }
  }
  return null;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  totalAgents: number;
  totalPoints: number;
  passed: number;
  failed: number;
  skipped: number;
  totalCostCents: number;
  results: MatrixResult[];
}

/**
 * Write the per-run summary JSON. Path is `results/<runId>/summary.json`
 * relative to the project root. CI uploads this as a workflow artifact;
 * locally it's a useful diff target across runs ("did case X get more
 * expensive after the prompt change?").
 */
export function writeSummary(projectRoot: string, summary: RunSummary): string {
  const dir = join(projectRoot, "tests", "e2e", "results", summary.runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "summary.json");
  writeFileSync(path, JSON.stringify(summary, null, 2));
  return path;
}

export function formatCents(cents: number | null): string {
  if (cents === null) return "$?";
  return `$${(cents / 100).toFixed(2)}`;
}
