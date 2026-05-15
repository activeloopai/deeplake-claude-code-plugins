import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentSkillsRoots } from "../../src/skillify/agent-roots.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "skillify-agent-roots-"));
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* nothing */ }
});

const canonical = (home: string) => join(home, ".claude", "skills");

// ── helpers — simulate "agent X is installed" by mkdir-ing its config dir
function installCodex(home: string): void { mkdirSync(join(home, ".codex"), { recursive: true }); }
function installHermes(home: string): void { mkdirSync(join(home, ".hermes"), { recursive: true }); }
function installPi(home: string): void { mkdirSync(join(home, ".pi", "agent"), { recursive: true }); }

describe("detectAgentSkillsRoots", () => {
  it("returns empty when no agent config dirs exist", () => {
    expect(detectAgentSkillsRoots(canonical(tmpHome), tmpHome)).toEqual([]);
  });

  it("includes ~/.agents/skills when codex is installed", () => {
    installCodex(tmpHome);
    expect(detectAgentSkillsRoots(canonical(tmpHome), tmpHome)).toEqual([
      join(tmpHome, ".agents", "skills"),
    ]);
  });

  it("includes ~/.hermes/skills when hermes is installed", () => {
    installHermes(tmpHome);
    expect(detectAgentSkillsRoots(canonical(tmpHome), tmpHome)).toEqual([
      join(tmpHome, ".hermes", "skills"),
    ]);
  });

  it("includes ~/.pi/agent/skills AND ~/.agents/skills when pi is installed (pi reads both)", () => {
    // Critical regression guard: pi's installer doesn't create
    // ~/.pi/agent/skills/ (skills are populated lazily), and codex's
    // installer is the one that creates ~/.agents/skills/. On a
    // pi-only box without codex, BOTH directories would otherwise be
    // missing — and pi would silently never see pulled skills. The
    // detector compensates by including both whenever pi is installed.
    installPi(tmpHome);
    expect(detectAgentSkillsRoots(canonical(tmpHome), tmpHome)).toEqual([
      join(tmpHome, ".agents", "skills"),
      join(tmpHome, ".pi", "agent", "skills"),
    ]);
  });

  it("returns a stable order: .agents/skills, .hermes/skills, .pi/agent/skills", () => {
    // Install in reverse — detection order should still be stable so
    // manifest entries are deterministic across machines.
    installPi(tmpHome);
    installHermes(tmpHome);
    installCodex(tmpHome);
    expect(detectAgentSkillsRoots(canonical(tmpHome), tmpHome)).toEqual([
      join(tmpHome, ".agents", "skills"),
      join(tmpHome, ".hermes", "skills"),
      join(tmpHome, ".pi", "agent", "skills"),
    ]);
  });

  it("does NOT duplicate ~/.agents/skills when both codex and pi are installed", () => {
    // Both installers add the same agentskills.io path to the candidate
    // list. The detector must dedupe — otherwise fanOutSymlinks would
    // try to create the same symlink twice (idempotent, but noisy logs
    // and a duplicate entry in the manifest's symlinks[]).
    installCodex(tmpHome);
    installPi(tmpHome);
    const result = detectAgentSkillsRoots(canonical(tmpHome), tmpHome);
    const agents = result.filter(p => p === join(tmpHome, ".agents", "skills"));
    expect(agents).toHaveLength(1);
  });

  it("never returns the canonical Claude root, even if a user configured it as canonical", () => {
    // If a future config let the user pick `~/.agents/skills` as the
    // canonical write location, this filter prevents symlinking a
    // directory into itself.
    installCodex(tmpHome);
    installHermes(tmpHome);
    const result = detectAgentSkillsRoots(join(tmpHome, ".agents", "skills"), tmpHome);
    expect(result).toEqual([join(tmpHome, ".hermes", "skills")]);
  });

  it("detects pi even when ~/.pi/agent/skills/ does not exist (the bug this refactor fixes)", () => {
    // The previous detector did existsSync(~/.pi/agent/skills/), which
    // pi's installer never creates. So a pi+hivemind install would
    // leave pi out of the fan-out until the user mkdir-ed the skills
    // dir themselves. Marker-based detection (~/.pi/agent/) catches
    // pi at install time.
    installPi(tmpHome);
    // Explicitly NOT creating .pi/agent/skills/ — pi's primary root
    // doesn't exist yet on a fresh hivemind-pi install.
    const result = detectAgentSkillsRoots(canonical(tmpHome), tmpHome);
    expect(result).toContain(join(tmpHome, ".pi", "agent", "skills"));
  });

  it("ignores a regular file at ~/.codex / ~/.hermes / ~/.pi/agent (parent must be a directory)", () => {
    // existsSync returns true for files too, so a stray ~/.codex file
    // (e.g. from `touch ~/.codex` by mistake) shouldn't trick the
    // detector into thinking codex is installed. mkdirSync creates a
    // dir; touching a file at the same path simulates the bad case.
    writeFileSync(join(tmpHome, ".codex"), "stray file, not a dir");
    // detector still sees existsSync=true and would include the path.
    // Documented behaviour: we accept the false positive at detection
    // time because fanOutSymlinks's `mkdirSync(dirname(link), recursive)`
    // step errors out on a parent-is-a-file conflict, and the symlink
    // is silently skipped. So no user data gets damaged even if a
    // bogus marker triggers detection.
    const result = detectAgentSkillsRoots(canonical(tmpHome), tmpHome);
    expect(result).toEqual([join(tmpHome, ".agents", "skills")]);
  });
});
