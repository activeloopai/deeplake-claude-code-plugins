/**
 * Standalone entrypoint that runs `autoPullSkills()` once and exits.
 * Bundled by esbuild for agents that can't import the shared module
 * (currently just pi, which ships its extension as raw .ts with zero
 * non-builtin runtime dependencies — see pi/extension-source/hivemind.ts).
 *
 * Pi spawns this synchronously from session_start and waits for it to
 * exit before assembling the additionalContext payload. That mirrors
 * the in-process `await autoPullSkills()` that codex / cursor / hermes
 * do directly — pi just routes through a child process because it
 * can't link the TypeScript code at extension-load time.
 *
 * The pull's 5-second internal timeout is the upper bound on this
 * worker's runtime; the parent's spawnSync should set a slightly
 * larger wall-clock cap (~6s) as a defence-in-depth measure.
 *
 * Always exits 0 — failures are already swallowed inside autoPullSkills.
 * The parent shouldn't react to the exit code.
 */

import { autoPullSkills } from "./auto-pull.js";

void (async () => {
  try {
    await autoPullSkills();
  } catch {
    // autoPullSkills is documented as never-rejecting; this catch is
    // a defensive belt-and-suspenders. Any failure here would still
    // be silent — the worker's stdio is "ignore"d by the parent.
  }
})();
