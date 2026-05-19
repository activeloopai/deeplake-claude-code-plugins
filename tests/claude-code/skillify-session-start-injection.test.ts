import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bundle-level guard: every agent's session-start.js bundle must inject the
 * SKILLS (skillify) section into the agent's developer context. Skillify
 * commands are part of the same hivemind family as the auth-login subcommands
 * — without this injection, agents have no way to discover that
 * `hivemind skillify pull --user X`, `--to global`, `--dry-run`, etc. exist.
 *
 * Each session-start.ts source file embeds the SKILLS section as a literal
 * string and resolves the HIVEMIND_CLI placeholder to the absolute path of
 * `bundle/cli.js` at runtime. These assertions catch any future refactor
 * that drops the injection or breaks the placeholder substitution.
 */

const BUNDLE_ROOT = resolve(process.cwd());

// Bundles that inject the SKILLS section into their hook's stdout. Codex is
// intentionally excluded: its harness renders hook stdout user-visible (see
// AGENT_CHANNELS.md → Codex), so the skillify command list lives in the
// auto-loaded `hivemind-memory` skill instead of the hook context.
const SESSION_START_BUNDLES: Array<[string, string]> = [
  ["claude-code", resolve(BUNDLE_ROOT, "claude-code", "bundle", "session-start.js")],
  ["cursor",      resolve(BUNDLE_ROOT, "cursor",      "bundle", "session-start.js")],
  ["hermes",      resolve(BUNDLE_ROOT, "hermes",      "bundle", "session-start.js")],
];

// Pi and OpenClaw don't go through the same esbuild bundle pipeline:
//   - Pi ships pi/extension-source/hivemind.ts as raw .ts (pi compiles it)
//   - OpenClaw exposes its surface via openclaw/skills/SKILL.md (loaded by
//     the openclaw runtime's skill index, not bundled JS)
// Codex sits here too: its skillify discoverability lives in
// codex/skills/deeplake-memory/SKILL.md (auto-loaded), not in the hook bundle.
const NON_BUNDLE_SURFACES: Array<[string, string]> = [
  ["pi-extension-source", resolve(BUNDLE_ROOT, "pi", "extension-source", "hivemind.ts")],
  ["openclaw-skill",      resolve(BUNDLE_ROOT, "openclaw", "skills", "SKILL.md")],
  ["codex-skill",         resolve(BUNDLE_ROOT, "codex", "skills", "deeplake-memory", "SKILL.md")],
];

// Codex bundle — separate matrix because it asserts a NEGATIVE: the slim
// invariant says the bundle MUST NOT inline the verbose skillify command list
// (every byte there is shown to the user as `hook context: ...`).
const CODEX_BUNDLE: [string, string] = [
  "codex", resolve(BUNDLE_ROOT, "codex", "bundle", "session-start.js"),
];

describe("skillify SessionStart injection (per-agent bundles)", () => {
  it.each(SESSION_START_BUNDLES)("%s bundle exists", (_label, p) => {
    expect(existsSync(p)).toBe(true);
  });

  it.each(SESSION_START_BUNDLES)(
    "%s bundle includes the SKILLS / Skill management section",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // Claude Code uses the long header "Skill management"; the others use
      // the short "SKILLS (skillify)" header. Either is acceptable.
      const hasHeader =
        text.includes("Skill management") || text.includes("SKILLS (skillify)");
      expect(hasHeader).toBe(true);
    }
  );

  it.each(SESSION_START_BUNDLES)(
    "%s bundle advertises the high-value skillify pull invocations",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // The exact subcommands every agent must surface to be useful.
      expect(text).toMatch(/skillify pull/);
      expect(text).toMatch(/skillify pull --user/);
      expect(text).toMatch(/skillify pull --users/);
      expect(text).toMatch(/skillify pull --all-users/);
      expect(text).toMatch(/skillify pull --dry-run/);
      expect(text).toMatch(/skillify scope/);
      expect(text).toMatch(/skillify team/);
    }
  );

  it.each(SESSION_START_BUNDLES)(
    "%s bundle uses bare `hivemind <sub>` form (no HIVEMIND_CLI placeholder leak)",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // After the npm-bin unification: the inject text uses bare `hivemind skillify`,
      // `hivemind login`, etc. There must be NO HIVEMIND_CLI const, NO placeholder
      // substitution, and NO literal "HIVEMIND_CLI" string in the inject anywhere.
      expect(text).not.toMatch(/HIVEMIND_CLI/);
      // The placeholder substitution call (`replace(/HIVEMIND_CLI/g, …)`) must
      // be gone — its presence would mean we forgot to delete it after the
      // unification.
      expect(text).not.toMatch(/replace\(\s*\/HIVEMIND_CLI/);
      // Inject must contain the bare hivemind invocations the agent should suggest.
      expect(text).toMatch(/hivemind skillify\b/);
    }
  );

  it.each(SESSION_START_BUNDLES)(
    "%s bundle Organization management section uses bare `hivemind <sub>` form",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // Org management was previously CC-only and used path-resolved form; now
      // propagated to all four hook-driven agents and unified on bare form.
      expect(text).toMatch(/Organization management/);
      expect(text).toMatch(/hivemind whoami\b/);
      expect(text).toMatch(/hivemind org list\b/);
      expect(text).toMatch(/hivemind invite\b/);
      // Must NOT contain the legacy `node "HIVEMIND_AUTH_CMD" <sub>` form
      expect(text).not.toMatch(/HIVEMIND_AUTH_CMD/);
      expect(text).not.toMatch(/auth-login\.js"\s+\w/);
    }
  );
});

describe("Codex bundle slim invariant + skill-as-source-of-truth", () => {
  it("Codex bundle exists", () => {
    expect(existsSync(CODEX_BUNDLE[1])).toBe(true);
  });

  it("Codex bundle does NOT inline the skillify command list (it lives in the skill)", () => {
    const text = readFileSync(CODEX_BUNDLE[1], "utf-8");
    // The skillify list belongs in codex/skills/deeplake-memory/SKILL.md
    // (auto-loaded by codex's skill loader) — emitting it via stdout would
    // dump ~50 lines into the user's `hook context: ...` history cell.
    expect(text).not.toMatch(/skillify pull --user/);
    expect(text).not.toMatch(/skillify scope/);
    expect(text).not.toMatch(/skillify mine-local/);
  });

  it("Codex bundle does NOT inline the verbose DEEPLAKE MEMORY tier doc", () => {
    const text = readFileSync(CODEX_BUNDLE[1], "utf-8");
    // Same reason — every byte here is user-visible in codex's TUI.
    expect(text).not.toMatch(/DEEPLAKE MEMORY: Persistent memory/);
    expect(text).not.toMatch(/Do NOT spawn subagents to read/);
  });

  it("Codex bundle output is JSON (not plain text) — required for systemMessage channel", () => {
    const text = readFileSync(CODEX_BUNDLE[1], "utf-8");
    // The hook must emit a JSON object with hookSpecificOutput so codex
    // routes systemMessage to the user-visible warning channel and
    // additionalContext to the model. The pre-0.118.0 plain-text fallback
    // lost the systemMessage channel entirely.
    expect(text).toContain("hookSpecificOutput");
    expect(text).toMatch(/hookEventName/);
  });
});

describe("skillify discoverability on non-bundle agent surfaces (Pi + OpenClaw + Codex skill)", () => {
  it.each(NON_BUNDLE_SURFACES)("%s file exists", (_label, p) => {
    expect(existsSync(p)).toBe(true);
  });

  it.each(NON_BUNDLE_SURFACES)(
    "%s advertises the skillify family (SKILLS / Skill Management section)",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      // Pi uses "SKILLS (skillify)" inline in its CONTEXT_PREAMBLE; OpenClaw's
      // SKILL.md uses a markdown "## Skill Management" header. Either is fine.
      const hasHeader =
        text.includes("SKILLS (skillify)") ||
        text.includes("Skill Management") ||
        text.includes("Skill management");
      expect(hasHeader).toBe(true);
    }
  );

  it.each(NON_BUNDLE_SURFACES)(
    "%s lists the high-value skillify pull invocations",
    (_label, p) => {
      const text = readFileSync(p, "utf-8");
      expect(text).toMatch(/skillify pull/);
      expect(text).toMatch(/skillify pull --user/);
      expect(text).toMatch(/skillify pull --users/);
      expect(text).toMatch(/skillify pull --all-users/);
      expect(text).toMatch(/skillify pull --dry-run/);
      expect(text).toMatch(/skillify scope/);
      expect(text).toMatch(/skillify team/);
    }
  );

  it("pi extension Organization management section uses bare `hivemind <sub>` form", () => {
    // Pi specifically: org management was missing (only CC had it before the
    // npm-bin unification) and now propagated. OpenClaw uses /hivemind_*
    // plugin-native commands which are a different surface — covered by
    // openclaw.plugin.json contracts.commands, not by this assertion.
    const text = readFileSync(resolve(BUNDLE_ROOT, "pi", "extension-source", "hivemind.ts"), "utf-8");
    expect(text).toMatch(/Organization management/);
    expect(text).toMatch(/hivemind whoami\b/);
    expect(text).toMatch(/hivemind org list\b/);
    expect(text).toMatch(/hivemind invite\b/);
  });
});

describe("Pi skillify worker (mining) wiring", () => {
  // Pi mines via a separate bundled worker spawned from session_shutdown,
  // installed alongside wiki-worker.js by `hivemind pi install`. These
  // assertions catch any regression that drops the bundle entry, removes
  // the install copy, or unwires the spawn call.

  it("ships pi/bundle/skillify-worker.js after build", () => {
    const p = resolve(BUNDLE_ROOT, "pi", "bundle", "skillify-worker.js");
    expect(existsSync(p)).toBe(true);
  });

  it("esbuild config registers the pi skillify-worker entry", () => {
    const cfg = readFileSync(resolve(BUNDLE_ROOT, "esbuild.config.mjs"), "utf-8");
    // Inside the piWorker array we must list the skillify-worker entry.
    expect(cfg).toMatch(/dist\/src\/skillify\/skillify-worker\.js[^"]*"\s*,\s*out:\s*"skillify-worker"/);
  });

  it("install-pi.ts copies pi/bundle/skillify-worker.js to ~/.pi/agent/hivemind/", () => {
    const src = readFileSync(resolve(BUNDLE_ROOT, "src", "cli", "install-pi.ts"), "utf-8");
    expect(src).toMatch(/SKILLIFY_WORKER_PATH\s*=/);
    // join(pkgRoot(), "pi", "bundle", "skillify-worker.js") — the source path
    expect(src).toMatch(/"pi",\s*"bundle",\s*"skillify-worker\.js"/);
    // copyFileSync(srcSkillifyWorker, SKILLIFY_WORKER_PATH) — the install step
    expect(src).toMatch(/copyFileSync\(srcSkillifyWorker,\s*SKILLIFY_WORKER_PATH\)/);
  });

  it("pi extension defines spawnPiSkillifyWorker and wires it into session_shutdown", () => {
    const ext = readFileSync(resolve(BUNDLE_ROOT, "pi", "extension-source", "hivemind.ts"), "utf-8");
    // Function exists
    expect(ext).toMatch(/function spawnPiSkillifyWorker\b/);
    // Path const points at the right install location
    expect(ext).toMatch(/PI_SKILLIFY_WORKER_PATH\s*=\s*join\(homedir\(\),\s*"\.pi",\s*"agent",\s*"hivemind",\s*"skillify-worker\.js"\)/);
    // Spawned with HIVEMIND_SKILLIFY_WORKER=1 + HIVEMIND_CAPTURE=false (recursion guard + no echo)
    expect(ext).toMatch(/HIVEMIND_SKILLIFY_WORKER:\s*"1"/);
    // session_shutdown handler invokes it after spawnWikiWorker
    expect(ext).toMatch(/session_shutdown[\s\S]{0,2000}spawnWikiWorker[\s\S]{0,500}spawnPiSkillifyWorker/);
  });

  it("pi skillify worker bundle embeds the same worker code as the other agents", () => {
    // Same shared module — guard against an accidental empty bundle by
    // checking the canonical entry-point + module markers are present.
    const text = readFileSync(resolve(BUNDLE_ROOT, "pi", "bundle", "skillify-worker.js"), "utf-8");
    // The worker reads its config from process.argv[2]
    expect(text).toMatch(/process\.argv\[2\]/);
    // The worker writes to the skills table via INSERT (append-only design)
    expect(text).toMatch(/INSERT INTO/);
    // The worker pulls in the skillify gate-runner module (per-agent CLI dispatch)
    expect(text).toMatch(/gate-runner|runGate/);
    // Worker-specific helper that doesn't appear in unrelated bundles
    expect(text).toMatch(/skillifyLog/);
  });
});

describe("OpenClaw skillify worker (mining) wiring", () => {
  // OpenClaw mines via a separate bundled worker spawned from the agent_end
  // hook. The worker bundle is built as a second openclaw esbuild entry
  // landing at openclaw/dist/skillify-worker.js (sibling of index.js).
  // install-openclaw.ts already copies the entire dist/ recursively, so
  // no install step change is required.

  it("ships openclaw/dist/skillify-worker.js after build", () => {
    const p = resolve(BUNDLE_ROOT, "openclaw", "dist", "skillify-worker.js");
    expect(existsSync(p)).toBe(true);
  });

  it("esbuild config registers the openclaw skillify-worker entry", () => {
    const cfg = readFileSync(resolve(BUNDLE_ROOT, "esbuild.config.mjs"), "utf-8");
    // The openclaw skillify-worker is a SEPARATE build call (so the main
    // openclaw bundle's child_process stub doesn't apply, and so the chunk
    // graph stays isolated from the gateway's split chunks).
    expect(cfg).toMatch(/"skillify-worker":\s*"dist\/src\/skillify\/skillify-worker\.js"/);
    // Window is generous to leave room for the bundle's comments + the
    // env-var → globalThis.__hivemind_tuning__ define dispatch table.
    expect(cfg).toMatch(/outdir:\s*"openclaw\/dist"[\s\S]{0,2000}skillify-worker/);
  });

  it("openclaw/src/index.ts bypasses the child_process stub via createRequire", () => {
    const src = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "src", "index.ts"), "utf-8");
    // The main openclaw bundle stubs out node:child_process to drop CC dead
    // code. createRequire(import.meta.url) is the runtime escape hatch — it
    // is NOT intercepted by esbuild's static analysis.
    expect(src).toMatch(/createRequire\s*\(\s*import\.meta\.url\s*\)/);
    expect(src).toMatch(/requireFromOpenclaw\("node:child_process"\)/);
  });

  it("openclaw/src/index.ts defines spawnOpenclawSkillifyWorker and wires it into agent_end", () => {
    const src = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "src", "index.ts"), "utf-8");
    expect(src).toMatch(/function spawnOpenclawSkillifyWorker\b/);
    // OPENCLAW_SKILLIFY_WORKER_PATH must be a sibling of import.meta.url
    expect(src).toMatch(/OPENCLAW_SKILLIFY_WORKER_PATH\s*=\s*joinPath\(__openclaw_dirname,\s*"skillify-worker\.js"\)/);
    // HIVEMIND_SKILLIFY_WORKER=1 recursion guard set on spawn env
    expect(src).toMatch(/HIVEMIND_SKILLIFY_WORKER:\s*"1"/);
    // Per-runtime dedup guard (#100) — explicit assertions so a future
    // refactor that drops the Set or its has/add usage fails this test
    // (CodeRabbit on #172).
    expect(src).toMatch(/const skillifySpawnedFor = new Set<string>\(\)/);
    expect(src).toMatch(/if \(!skillifySpawnedFor\.has\(sid\)\)/);
    expect(src).toMatch(/skillifySpawnedFor\.add\(sid\)/);
    // agent_end hook calls it after the capture loop. Distance bumped
    // from 500→1500 to accommodate the per-runtime spawn-dedup comment
    // block landed for #100 between `Auto-captured` and the spawn site.
    // 3500→4000 for the embed-on-capture wiring landed for #178 between
    // `agent_end` and `Auto-captured` (tryEmbedStandalone + comment block).
    expect(src).toMatch(/agent_end[\s\S]{0,4000}Auto-captured[\s\S]{0,1500}spawnOpenclawSkillifyWorker/);
    // install: "global" — no per-project cwd, skills land under ~/.claude/skills/
    expect(src).toMatch(/install:\s*"global"/);
  });

  it("openclaw bundle preserves the createRequire spawn (not stubbed by esbuild)", () => {
    const text = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "dist", "index.js"), "utf-8");
    // After bundling, the createRequire + dynamic require call must still be there
    expect(text).toMatch(/createRequire\(import\.meta\.url\)/);
    expect(text).toMatch(/requireFromOpenclaw\("node:child_process"\)/);
    // realSpawn extracted from the dynamic require — actual function at runtime.
    // The destructure may also pull other primitives (e.g. execFileSync) for the
    // gate-agent detection path; allow extra destructured fields.
    expect(text).toMatch(/var\s*\{\s*spawn:\s*realSpawn[\s\S]{0,200}\}\s*=\s*requireFromOpenclaw/);
    // spawnOpenclawSkillifyWorker function present in bundle
    expect(text).toMatch(/spawnOpenclawSkillifyWorker/);
    // realSpawn(process.execPath, [path, configPath], ...) — the actual spawn site
    expect(text).toMatch(/realSpawn\(process\.execPath/);
  });

  it("openclaw spawn helper detects a delegate gate CLI and threads gateAgent into the worker config", () => {
    // Issue: openclaw isn't itself a CLI agent (no `openclaw -p <prompt>`),
    // so passing agent="openclaw" to the gate-runner produces "agent binary
    // not found at undefined". Fix: detect a real CLI on PATH at spawn time
    // and pass it as `gateAgent`; the worker dispatches `runGate` against
    // that delegate while keeping `agent: "openclaw"` for source_agent
    // provenance in the skills table. Regression guard.
    const src = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "src", "index.ts"), "utf-8");
    expect(src).toMatch(/function detectOpenclawGateAgent\b/);
    // The candidate list: the five CLIs the worker's gate-runner knows about.
    expect(src).toMatch(/"claude_code",\s*"claude"/);
    expect(src).toMatch(/"codex",\s*"codex"/);
    expect(src).toMatch(/"cursor",\s*"cursor-agent"/);
    expect(src).toMatch(/"hermes",\s*"hermes"/);
    expect(src).toMatch(/"pi",\s*"pi"/);
    // Spawn helper bails out early if no delegate is on PATH (don't waste IO).
    expect(src).toMatch(/no delegate gate CLI found/);
    // gateAgent threaded into the worker config — same key the worker reads.
    expect(src).toMatch(/gateAgent,/);
    // Bundled output must preserve the detection + threading.
    const text = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "dist", "index.js"), "utf-8");
    expect(text).toMatch(/detectOpenclawGateAgent/);
    expect(text).toMatch(/gateAgent/);
    expect(text).toMatch(/no delegate gate CLI found/);
  });

  it("openclaw worker bundle embeds the same shared worker code as other agents", () => {
    const text = readFileSync(resolve(BUNDLE_ROOT, "openclaw", "dist", "skillify-worker.js"), "utf-8");
    expect(text).toMatch(/process\.argv\[2\]/);
    expect(text).toMatch(/INSERT INTO/);
    expect(text).toMatch(/gate-runner|runGate/);
    expect(text).toMatch(/skillifyLog/);
  });
});

describe("hivemind CLI USAGE help advertises skillify", () => {
  // Source-of-truth scan: USAGE block in src/cli/index.ts must list skillify.
  // Bundle scan would also work but the source is canonical for help text.
  it("`hivemind --help` documents the skillify subcommand family", () => {
    const cli = resolve(BUNDLE_ROOT, "bundle", "cli.js");
    const text = readFileSync(cli, "utf-8");
    expect(text).toMatch(/Skill management/);
    expect(text).toMatch(/hivemind skillify pull/);
    expect(text).toMatch(/hivemind skillify scope/);
    expect(text).toMatch(/hivemind skillify team/);
  });
});
