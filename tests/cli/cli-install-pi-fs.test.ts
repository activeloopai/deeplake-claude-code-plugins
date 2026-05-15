import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the disk-side of src/cli/install-pi.ts. The pure helpers
 * (`upsertHivemindBlock`, `stripHivemindBlock`) already have coverage
 * in install-helpers.test.ts. Here we drive installPi / uninstallPi
 * end-to-end against a tmp ~/.pi/agent/ tree, exercising:
 *   - AGENTS.md create + idempotent re-install
 *   - extension copy + version stamp
 *   - legacy SKILL.md cleanup
 *   - uninstall preserving non-hivemind AGENTS.md content
 */

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `hm-pi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");
  mkdirSync(tmpHome, { recursive: true });

  mkdirSync(join(tmpPkg, "pi", "extension-source"), { recursive: true });
  writeFileSync(join(tmpPkg, "pi", "extension-source", "hivemind.ts"), "// fake pi extension");
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "7.7.7" }));

  vi.stubEnv("HOME", tmpHome);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importInstaller(): Promise<typeof import("../../src/cli/install-pi.js")> {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-pi.js");
}

const BEGIN = "<!-- BEGIN hivemind-memory -->";
const END = "<!-- END hivemind-memory -->";

describe("installPi — cold install", () => {
  it("creates AGENTS.md with exactly one hivemind marker pair", async () => {
    const { installPi } = await importInstaller();
    installPi();
    const agents = readFileSync(join(tmpHome, ".pi", "agent", "AGENTS.md"), "utf-8");
    expect(agents).toContain(BEGIN);
    expect(agents).toContain(END);
    expect((agents.match(new RegExp(BEGIN, "g")) ?? []).length).toBe(1);
  });

  it("copies the extension source verbatim", async () => {
    const { installPi } = await importInstaller();
    installPi();
    const dst = readFileSync(join(tmpHome, ".pi", "agent", "extensions", "hivemind.ts"), "utf-8");
    expect(dst).toBe("// fake pi extension");
  });

  it("stamps the version under the .hivemind sentinel directory", async () => {
    const { installPi } = await importInstaller();
    installPi();
    expect(readFileSync(join(tmpHome, ".pi", "agent", ".hivemind", ".hivemind_version"), "utf-8"))
      .toBe("7.7.7");
  });

  it("throws with a 'reinstall the package' hint when the extension source is absent", async () => {
    rmSync(join(tmpPkg, "pi", "extension-source"), { recursive: true, force: true });
    const { installPi } = await importInstaller();
    expect(() => installPi()).toThrow(/pi extension source missing/);
    expect(() => installPi()).toThrow(/Reinstall the @deeplake\/hivemind package/);
  });
});

describe("installPi — re-install / cleanup", () => {
  it("preserves a user's pre-existing AGENTS.md content; appends the hivemind block once", async () => {
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(join(tmpHome, ".pi", "agent", "AGENTS.md"), "# My Pi notes\nUser content here.\n");
    const { installPi } = await importInstaller();
    installPi();
    const agents = readFileSync(join(tmpHome, ".pi", "agent", "AGENTS.md"), "utf-8");
    expect(agents).toContain("# My Pi notes");
    expect(agents).toContain("User content here.");
    expect((agents.match(new RegExp(BEGIN, "g")) ?? []).length).toBe(1);
  });

  it("re-running installPi 5x produces exactly one block (idempotent)", async () => {
    const { installPi } = await importInstaller();
    for (let i = 0; i < 5; i++) installPi();
    const agents = readFileSync(join(tmpHome, ".pi", "agent", "AGENTS.md"), "utf-8");
    expect((agents.match(new RegExp(BEGIN, "g")) ?? []).length).toBe(1);
    expect((agents.match(new RegExp(END, "g")) ?? []).length).toBe(1);
  });

  it("cleans up the legacy per-agent SKILL.md drop on install", async () => {
    // Older installer dropped a SKILL.md under skills/hivemind-memory/ —
    // now removed because pi reads the shared agentskills location too,
    // creating a collision with the codex installer.
    const legacy = join(tmpHome, ".pi", "agent", "skills", "hivemind-memory");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "stale skill body");
    const { installPi } = await importInstaller();
    installPi();
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("uninstallPi", () => {
  it("strips the hivemind block from AGENTS.md while preserving user content", async () => {
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "AGENTS.md"),
      `# Header\nuser line\n\n${BEGIN}\nstale\n${END}\n\n## After\nmore user\n`,
    );
    const { uninstallPi } = await importInstaller();
    uninstallPi();
    const agents = readFileSync(join(tmpHome, ".pi", "agent", "AGENTS.md"), "utf-8");
    expect(agents).not.toContain(BEGIN);
    expect(agents).not.toContain(END);
    expect(agents).toContain("# Header");
    expect(agents).toContain("user line");
    expect(agents).toContain("more user");
  });

  it("removes AGENTS.md when nothing remains after stripping", async () => {
    const { installPi, uninstallPi } = await importInstaller();
    installPi();
    uninstallPi();
    expect(existsSync(join(tmpHome, ".pi", "agent", "AGENTS.md"))).toBe(false);
  });

  it("removes the extension file and the version sentinel dir", async () => {
    const { installPi, uninstallPi } = await importInstaller();
    installPi();
    uninstallPi();
    expect(existsSync(join(tmpHome, ".pi", "agent", "extensions", "hivemind.ts"))).toBe(false);
    expect(existsSync(join(tmpHome, ".pi", "agent", ".hivemind"))).toBe(false);
  });

  it("removes the legacy SKILL.md drop if it survived from an older installer", async () => {
    const legacy = join(tmpHome, ".pi", "agent", "skills", "hivemind-memory");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "stale");
    const { uninstallPi } = await importInstaller();
    uninstallPi();
    expect(existsSync(legacy)).toBe(false);
  });

  it("is a no-op when nothing exists (cold uninstall)", async () => {
    const { uninstallPi } = await importInstaller();
    expect(() => uninstallPi()).not.toThrow();
  });
});
