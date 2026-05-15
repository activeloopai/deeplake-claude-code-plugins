import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for src/cli/install-openclaw.ts. The installer mirrors the
 * package layout under ~/.openclaw/extensions/hivemind, copying dist/
 * + manifest + skills, then writing a version stamp.
 */

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `hm-claw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");
  mkdirSync(tmpHome, { recursive: true });

  mkdirSync(join(tmpPkg, "openclaw", "dist"), { recursive: true });
  writeFileSync(join(tmpPkg, "openclaw", "dist", "index.js"), "// fake dist");
  writeFileSync(join(tmpPkg, "openclaw", "openclaw.plugin.json"), JSON.stringify({ name: "hivemind", version: "1.2.3" }));
  writeFileSync(join(tmpPkg, "openclaw", "package.json"), JSON.stringify({ name: "hivemind", version: "1.2.3" }));
  mkdirSync(join(tmpPkg, "openclaw", "skills"), { recursive: true });
  writeFileSync(join(tmpPkg, "openclaw", "skills", "hivemind.md"), "skill body");
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "1.2.3" }));

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

async function importInstaller(): Promise<typeof import("../../src/cli/install-openclaw.js")> {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-openclaw.js");
}

describe("installOpenclaw", () => {
  it("creates the plugin dir, copies dist, manifest, package.json, and skills", async () => {
    const { installOpenclaw } = await importInstaller();
    installOpenclaw();

    const root = join(tmpHome, ".openclaw", "extensions", "hivemind");
    expect(existsSync(join(root, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(root, "openclaw.plugin.json"))).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "skills", "hivemind.md"))).toBe(true);
    expect(readFileSync(join(root, ".hivemind_version"), "utf-8")).toBe("1.2.3");
  });

  it("copies the manifest as a file (not into a directory) — uses copyFileSync, not copyDir", async () => {
    // CLAUDE.md rule 8: regression — copyDir on a file destination would
    // land it INSIDE a pre-existing directory of the same name. Force
    // that condition and verify the manifest still ends up at the
    // expected file path.
    const root = join(tmpHome, ".openclaw", "extensions", "hivemind");
    mkdirSync(join(root, "openclaw.plugin.json"), { recursive: true });
    const { installOpenclaw } = await importInstaller();
    // copyFileSync over a directory will throw — that itself is the
    // signal the file path is reserved-as-file. We accept either
    // outcome: a thrown error, OR a successful overwrite (depending
    // on platform). The key contract is that it does NOT silently nest.
    try { installOpenclaw(); } catch { /* either branch is acceptable */ }
    // The path is either a file (copyFileSync overwrote it) or still a
    // directory (copyFileSync threw), but never a directory containing
    // the manifest as a file inside.
    if (existsSync(join(root, "openclaw.plugin.json", "openclaw.plugin.json"))) {
      throw new Error("copyDir-on-file regression: nested manifest detected");
    }
  });

  it("skips optional sources that don't exist (skills, manifest) without throwing", async () => {
    rmSync(join(tmpPkg, "openclaw", "skills"), { recursive: true, force: true });
    rmSync(join(tmpPkg, "openclaw", "openclaw.plugin.json"));
    const { installOpenclaw } = await importInstaller();
    expect(() => installOpenclaw()).not.toThrow();
    const root = join(tmpHome, ".openclaw", "extensions", "hivemind");
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(root, "openclaw.plugin.json"))).toBe(false);
    expect(existsSync(join(root, "dist", "index.js"))).toBe(true);
  });

  it("throws when the dist source is missing (build hasn't run)", async () => {
    rmSync(join(tmpPkg, "openclaw", "dist"), { recursive: true, force: true });
    const { installOpenclaw } = await importInstaller();
    expect(() => installOpenclaw()).toThrow(/OpenClaw bundle missing/);
  });
});

describe("uninstallOpenclaw", () => {
  it("removes the entire plugin directory", async () => {
    const { installOpenclaw, uninstallOpenclaw } = await importInstaller();
    installOpenclaw();
    const root = join(tmpHome, ".openclaw", "extensions", "hivemind");
    expect(existsSync(root)).toBe(true);
    uninstallOpenclaw();
    expect(existsSync(root)).toBe(false);
  });

  it("logs 'nothing to remove' when the plugin dir is absent (cold uninstall)", async () => {
    const writes: string[] = [];
    (process.stdout.write as any).mockImplementation((s: string) => { writes.push(s); return true; });
    const { uninstallOpenclaw } = await importInstaller();
    uninstallOpenclaw();
    expect(writes.join("")).toContain("nothing to remove");
  });
});
