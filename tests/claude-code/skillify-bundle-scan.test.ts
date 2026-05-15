import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guard: assert the skillify worker is actually shipped in
 * every agent's bundle and that each agent's hook bundle contains the
 * trigger wiring. Source-level tests prove the modules are correct;
 * these tests prove `npm run build` didn't drop them.
 */

const ROOT = process.cwd();
// openclaw is a separate npm sub-package and writes its build to `dist/`
// (gitignored, regenerated on `npm run build`), whereas the other agents
// commit their bundles under `bundle/`. We still want the shared worker
// bundle (skillify-worker.js) to pass the same shape + content guards on
// openclaw, since it is rebuilt from the same src/skillify/skillify-worker.ts.
const AGENTS = ["claude-code", "codex", "cursor", "hermes", "openclaw"] as const;

function bundlePath(agent: string, file: string): string {
  const dir = agent === "openclaw" ? "dist" : "bundle";
  return join(ROOT, agent, dir, file);
}

describe("skillify-worker bundle is shipped per agent", () => {
  for (const agent of AGENTS) {
    const bundleDir = agent === "openclaw" ? "dist" : "bundle";
    it(`${agent}/${bundleDir}/skillify-worker.js exists and contains the worker entry`, () => {
      const path = bundlePath(agent, "skillify-worker.js");
      expect(existsSync(path), `${path} missing`).toBe(true);
      const text = readFileSync(path, "utf-8");
      // Sanity: bundle should have the skillify log channel and the gate prompt.
      expect(text).toContain("skillify-worker(");
      // Gate-prompt heading: was "EXISTING PROJECT SKILLS" pre-#119;
      // became "EXISTING SKILLS" after the project + global merge; #118
      // appended the contributors auto-promote clause so we check that
      // the prompt explicitly mentions cross-author MERGE + scope=team.
      expect(text).toContain("EXISTING SKILLS");
      expect(text).toContain("scope=team");
      expect(text).toContain("Cross-author MERGE");
      // Watermark advance is the SKIP hot path.
      expect(text).toContain("advancing watermark");
    });
  }
});

describe("triggers are wired in each agent's hook bundles", () => {
  it("claude-code: capture.js (Stop counter) AND session-end.js (force trigger)", () => {
    const cap = readFileSync(bundlePath("claude-code", "capture.js"), "utf-8");
    expect(cap).toContain("tryStopCounterTrigger");
    const se = readFileSync(bundlePath("claude-code", "session-end.js"), "utf-8");
    expect(se).toContain("forceSessionEndTrigger");
  });

  it("codex: stop.js fires forceSessionEndTrigger (Codex Stop is end-of-session)", () => {
    const stop = readFileSync(bundlePath("codex", "stop.js"), "utf-8");
    expect(stop).toContain("forceSessionEndTrigger");
  });

  it("cursor: capture.js Stop counter on afterAgentResponse + session-end.js force trigger", () => {
    const cap = readFileSync(bundlePath("cursor", "capture.js"), "utf-8");
    expect(cap).toContain("tryStopCounterTrigger");
    expect(cap).toContain("afterAgentResponse");
    const se = readFileSync(bundlePath("cursor", "session-end.js"), "utf-8");
    expect(se).toContain("forceSessionEndTrigger");
  });

  it("hermes: capture.js Stop counter on post_llm_call + session-end.js force trigger", () => {
    const cap = readFileSync(bundlePath("hermes", "capture.js"), "utf-8");
    expect(cap).toContain("tryStopCounterTrigger");
    expect(cap).toContain("post_llm_call");
    const se = readFileSync(bundlePath("hermes", "session-end.js"), "utf-8");
    expect(se).toContain("forceSessionEndTrigger");
  });
});

describe("each agent records the correct agent name", () => {
  it("claude-code passes agent: 'claude_code' to triggers", () => {
    const cap = readFileSync(bundlePath("claude-code", "capture.js"), "utf-8");
    const se = readFileSync(bundlePath("claude-code", "session-end.js"), "utf-8");
    expect(cap + se).toContain(`"claude_code"`);
  });
  it("codex passes agent: 'codex' to triggers", () => {
    expect(readFileSync(bundlePath("codex", "stop.js"), "utf-8")).toContain(`"codex"`);
  });
  it("cursor passes agent: 'cursor' to triggers", () => {
    const cap = readFileSync(bundlePath("cursor", "capture.js"), "utf-8");
    const se = readFileSync(bundlePath("cursor", "session-end.js"), "utf-8");
    expect(cap + se).toContain(`"cursor"`);
  });
  it("hermes passes agent: 'hermes' to triggers", () => {
    const cap = readFileSync(bundlePath("hermes", "capture.js"), "utf-8");
    const se = readFileSync(bundlePath("hermes", "session-end.js"), "utf-8");
    expect(cap + se).toContain(`"hermes"`);
  });
});

describe("known anti-patterns are absent from bundled worker", () => {
  it("does not UPDATE the skills table — append-only by design (CLAUDE.md UPDATE-coalescing quirk)", () => {
    for (const agent of AGENTS) {
      const text = readFileSync(bundlePath(agent, "skillify-worker.js"), "utf-8");
      expect(text, `${agent}: skillify-worker.js contains UPDATE on skills table`).not.toMatch(/UPDATE\s+"?skills"?\s+SET/i);
    }
  });
});

describe("legacy state-dir migration is shipped in every agent's bundle", () => {
  // The migration call wires into the four read/write entry points so a
  // post-rename worker / SessionStart sees the migrated state. If any of
  // these regressions ship, users with a populated ~/.deeplake/state/skilify/
  // would silently start fresh on ~/.deeplake/state/skillify/.
  //
  // claude-code/codex/cursor/hermes/openclaw ship the shared TS module
  // compiled into skillify-worker.js + the SessionStart hooks. pi ships
  // skillify-worker.js too (no SessionStart hook). openclaw additionally
  // ships an inlined helper inside index.js (its self-contained bundle
  // can't import from src/skillify) — that one is covered by the
  // dedicated test below.
  const SHARED_AGENTS = [...AGENTS, "pi"] as const;

  for (const agent of SHARED_AGENTS) {
    const bundleDir = agent === "openclaw" ? "dist" : "bundle";
    it(`${agent}/${bundleDir}/skillify-worker.js: migration helper present and called from readState`, () => {
      const text = readFileSync(bundlePath(agent, "skillify-worker.js"), "utf-8");
      expect(text, `${agent}: migrateLegacyStateDir helper missing`).toContain("function migrateLegacyStateDir");
      // readState is the first state file the worker touches; if migration
      // isn't called here the worker re-mines already-processed sessions.
      expect(text, `${agent}: readState missing migrateLegacyStateDir call`).toMatch(
        /function readState\([^)]*\)\s*\{\s*migrateLegacyStateDir\(\)/,
      );
      // Narrow-catch behaviour: only EXDEV/EPERM swallowed; everything else rethrows.
      expect(text, `${agent}: migration swallows too broadly`).toMatch(
        /code === "EXDEV" \|\| code === "EPERM"/,
      );
    });
  }

  it("openclaw/dist/index.js: inlined migration present and called before fsMkdir", () => {
    const text = readFileSync(join(ROOT, "openclaw", "dist", "index.js"), "utf-8");
    expect(text).toContain("function migrateOpenclawSkillifyLegacyStateDir");
    // Must be called inside tryAcquireOpenclawSkillifyLock before the fsMkdir.
    // The order matters: once fsMkdir creates the new dir, the migration
    // becomes a no-op and any legacy data is orphaned.
    expect(text).toMatch(
      /function tryAcquireOpenclawSkillifyLock[\s\S]{0,200}migrateOpenclawSkillifyLegacyStateDir\(\)[\s\S]{0,200}fsMkdir/,
    );
    // Same narrow-catch as the shared helper.
    expect(text).toMatch(/code === "EXDEV" \|\| code === "EPERM"/);
  });
});
