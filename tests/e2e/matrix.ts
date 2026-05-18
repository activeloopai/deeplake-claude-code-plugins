/**
 * Matrix registry.
 *
 * Drivers are listed explicitly — there are six, the set is stable, and
 * adding one is a deliberate architectural change. Cases, in contrast,
 * are **auto-discovered** from `tests/e2e/cases/*.ts`: drop a new file
 * in that directory, export it as `default`, and the matrix runs it
 * against every applicable agent on the next invocation. No edits here
 * required to add a behavior.
 *
 * Discovery rules:
 *   - File must live directly under `tests/e2e/cases/` (not nested).
 *   - File name must end in `.ts` and start with a digit (so `01-foo.ts`
 *     sorts deterministically before `02-foo.ts`).
 *   - File MUST export the case as its default export.
 *   - The default export MUST satisfy the `E2ECase` shape: an object
 *     with string `id`, string `prompt`, and an array `assertions`.
 *     Anything else is silently skipped with a stderr warning.
 *
 * No editing this file is required when adding a case. Adding an agent
 * (which is rare) still requires a manual import + ALL_DRIVERS line.
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { AgentDriver, E2ECase, AgentId } from "./types.js";
import { claudeCodeDriver } from "./agents/claude-code.js";
import { codexDriver } from "./agents/codex.js";
import { cursorAgentDriver } from "./agents/cursor-agent.js";
import { hermesDriver } from "./agents/hermes.js";
import { piDriver } from "./agents/pi.js";
import { openclawDriver } from "./agents/openclaw.js";

export const ALL_DRIVERS: AgentDriver[] = [
  claudeCodeDriver,
  codexDriver,
  cursorAgentDriver,
  hermesDriver,
  piDriver,
  openclawDriver,
];

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = resolve(HERE, "cases");

/**
 * Validate that an unknown value is a usable case object. Permissive —
 * we trust TypeScript at compile time for the per-file shape and only
 * guard the bare minimum the runner needs to dispatch.
 */
function isE2ECase(v: unknown): v is E2ECase {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.prompt === "string" &&
    Array.isArray(c.assertions)
  );
}

/**
 * Discover every case file in `cases/`, dynamic-import its default
 * export, validate the shape, sort by id (which embeds the numeric
 * prefix). Returns the assembled `E2ECase[]`.
 *
 * Files without a default export, with a malformed export, or that
 * throw at import time are skipped with a stderr warning — a half-
 * written case file shouldn't take down the entire matrix.
 */
export async function loadAllCases(): Promise<E2ECase[]> {
  let names: string[];
  try {
    names = readdirSync(CASE_DIR)
      .filter((f) => f.endsWith(".ts") && /^\d/.test(f))
      .sort();
  } catch (e) {
    console.warn(`[matrix] could not list cases dir ${CASE_DIR}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const cases: E2ECase[] = [];
  for (const name of names) {
    const fullPath = resolve(CASE_DIR, name);
    let mod: { default?: unknown };
    try {
      mod = await import(pathToFileURL(fullPath).href);
    } catch (e) {
      console.warn(`[matrix] skipping ${name}: import failed — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!mod.default) {
      console.warn(`[matrix] skipping ${name}: no default export`);
      continue;
    }
    if (!isE2ECase(mod.default)) {
      console.warn(`[matrix] skipping ${name}: default export is not a valid E2ECase (missing id/prompt/assertions)`);
      continue;
    }
    cases.push(mod.default);
  }
  return cases;
}

export interface MatrixPoint {
  case: E2ECase;
  agent: AgentDriver;
  /** True when the case explicitly declares it doesn't apply to this agent. */
  skipped: boolean;
  skipReason: string | null;
}

/** Build the (case × agent) cross-product, honoring per-case skip-lists. */
export function buildMatrix(
  cases: E2ECase[],
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
