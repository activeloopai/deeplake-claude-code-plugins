import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the disk-side of src/cli/install-codex.ts.
 *
 * The pure helpers (`isHivemindHookEntry`, `mergeHooks`) already have
 * coverage in install-helpers.test.ts. Here we exercise installCodex /
 * uninstallCodex against a real (tmp) ~/.codex layout — copying the
 * fake bundle, writing hooks.json, dropping the agentskills symlink,
 * stamping the version, and the uninstall counterpart.
 *
 * To redirect HOME and pkgRoot to the tmp dir we:
 *   - stub process.env.HOME before importing util.js (so homedir() picks
 *     up the tmp path) and
 *   - vi.doMock util.js's pkgRoot() to return the tmp source root
 * (CLAUDE.md rule 5: mock at the boundary, not in the middle.)
 */

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;
const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

beforeEach(() => {
  tmpRoot = join(tmpdir(), `hm-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");

  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(join(tmpHome, ".codex"), { recursive: true });

  // Mock package layout: pkgRoot/codex/{bundle,skills}/<files>
  mkdirSync(join(tmpPkg, "codex", "bundle"), { recursive: true });
  writeFileSync(join(tmpPkg, "codex", "bundle", "session-start.js"), "// fake bundle file");
  writeFileSync(join(tmpPkg, "codex", "bundle", "capture.js"), "// fake bundle file");
  mkdirSync(join(tmpPkg, "codex", "skills", "deeplake-memory"), { recursive: true });
  writeFileSync(join(tmpPkg, "codex", "skills", "deeplake-memory", "SKILL.md"), "fake skill body");
  mkdirSync(join(tmpPkg, "codex", "skills", "gdd-workflow"), { recursive: true });
  writeFileSync(join(tmpPkg, "codex", "skills", "gdd-workflow", "SKILL.md"), "fake gdd skill body");
  // Mock package.json so getVersion() resolves to a known value.
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "1.2.3" }));

  vi.stubEnv("HOME", tmpHome);
  execFileSyncMock.mockReset();
  // Silence stdout/stderr noise from the installer's log() calls.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importInstaller(): Promise<typeof import("../../src/cli/install-codex.js")> {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-codex.js");
}

describe("installCodex — happy path", () => {
  it("creates the plugin dir, copies the bundle, writes the skill symlink target, and stamps version", async () => {
    const { installCodex } = await importInstaller();
    installCodex();

    const pluginDir = join(tmpHome, ".codex", "hivemind");
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "bundle", "session-start.js"))).toBe(true);
    expect(existsSync(join(pluginDir, "bundle", "capture.js"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "deeplake-memory", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "gdd-workflow", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(pluginDir, ".hivemind_version"), "utf-8")).toBe("1.2.3");
  });

  it("writes a hooks.json with exactly five hivemind events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop", async () => {
    const { installCodex } = await importInstaller();
    installCodex();

    const hooks = JSON.parse(readFileSync(join(tmpHome, ".codex", "hooks.json"), "utf-8"));
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
    // Each of our events ships exactly one entry on cold install.
    for (const event of Object.keys(hooks.hooks)) {
      expect(hooks.hooks[event]).toHaveLength(1);
    }
    // PreToolUse carries the Bash matcher.
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  it("creates the agentskills symlink at ~/.agents/skills/hivemind-memory", async () => {
    const { installCodex } = await importInstaller();
    installCodex();

    const link = join(tmpHome, ".agents", "skills", "hivemind-memory");
    expect(existsSync(link)).toBe(true);
    // Validate it points at the real on-disk skill payload.
    expect(existsSync(join(link, "SKILL.md"))).toBe(true);
  });

  it("creates the agentskills symlink at ~/.agents/skills/gdd-workflow", async () => {
    const { installCodex } = await importInstaller();
    installCodex();

    const link = join(tmpHome, ".agents", "skills", "gdd-workflow");
    expect(existsSync(link)).toBe(true);
    expect(existsSync(join(link, "SKILL.md"))).toBe(true);
  });

  it("attempts to enable codex hooks via the codex CLI (best-effort, no throw on failure)", async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("codex not installed"); });
    const { installCodex } = await importInstaller();
    expect(() => installCodex()).not.toThrow();
    // We did try.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codex",
      ["features", "enable", "codex_hooks"],
      expect.any(Object),
    );
  });

  it("preserves a user-defined hook on a non-hivemind event when re-installing over an existing config", async () => {
    // CLAUDE.md rule 12: failure case before the fix surface — write the
    // shape of an existing hooks.json that the bug would clobber.
    const userHook = {
      hooks: [{ type: "command", command: "/usr/local/bin/audit.sh", timeout: 5 }],
    };
    writeFileSync(
      join(tmpHome, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { Notification: [userHook] }, version: 7 }),
    );

    const { installCodex } = await importInstaller();
    installCodex();

    const hooks = JSON.parse(readFileSync(join(tmpHome, ".codex", "hooks.json"), "utf-8"));
    expect(hooks.hooks.Notification).toHaveLength(1);
    expect(hooks.hooks.Notification[0]).toEqual(userHook);
    // Top-level metadata survives.
    expect(hooks.version).toBe(7);
  });

  it("re-install over a malformed hooks.json does not throw and writes a fresh one", async () => {
    writeFileSync(join(tmpHome, ".codex", "hooks.json"), "{ not json");
    const { installCodex } = await importInstaller();
    expect(() => installCodex()).not.toThrow();
    const hooks = JSON.parse(readFileSync(join(tmpHome, ".codex", "hooks.json"), "utf-8"));
    expect(hooks.hooks.SessionStart).toBeDefined();
  });

  it("warns and skips the symlink (without throwing) when the skill source is missing", async () => {
    rmSync(join(tmpPkg, "codex", "skills", "deeplake-memory"), { recursive: true, force: true });
    rmSync(join(tmpPkg, "codex", "skills", "gdd-workflow"), { recursive: true, force: true });
    const { installCodex } = await importInstaller();
    expect(() => installCodex()).not.toThrow();
    expect(existsSync(join(tmpHome, ".agents", "skills", "hivemind-memory"))).toBe(false);
    expect(existsSync(join(tmpHome, ".agents", "skills", "gdd-workflow"))).toBe(false);
  });

  it("throws when the bundle source is missing (build hasn't run)", async () => {
    rmSync(join(tmpPkg, "codex", "bundle"), { recursive: true, force: true });
    const { installCodex } = await importInstaller();
    expect(() => installCodex()).toThrow(/Codex bundle missing/);
  });
});

describe("uninstallCodex", () => {
  it("removes hooks.json and the agentskills symlink, but keeps the plugin payload", async () => {
    const { installCodex, uninstallCodex } = await importInstaller();
    installCodex();
    expect(existsSync(join(tmpHome, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(tmpHome, ".agents", "skills", "hivemind-memory"))).toBe(true);
    expect(existsSync(join(tmpHome, ".agents", "skills", "gdd-workflow"))).toBe(true);

    uninstallCodex();
    expect(existsSync(join(tmpHome, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(tmpHome, ".agents", "skills", "hivemind-memory"))).toBe(false);
    expect(existsSync(join(tmpHome, ".agents", "skills", "gdd-workflow"))).toBe(false);
    // Plugin payload is intentionally preserved (lets the user re-install
    // without re-downloading) — assert the bundle is still there.
    expect(existsSync(join(tmpHome, ".codex", "hivemind", "bundle", "session-start.js"))).toBe(true);
  });

  it("is a no-op when there's nothing to remove (cold uninstall)", async () => {
    const { uninstallCodex } = await importInstaller();
    expect(() => uninstallCodex()).not.toThrow();
  });
});
