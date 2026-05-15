import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the disk-side of src/cli/install-cursor.ts.
 *
 * Pure helpers (`isHivemindEntry`, `stripHooksFromConfig`) are covered in
 * install-helpers.test.ts. Here we drive installCursor / uninstallCursor
 * end-to-end against a tmp ~/.cursor and assert SHAPE AND COUNT of the
 * resulting hooks.json (CLAUDE.md rule 6) plus the marker-key contract.
 */

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `hm-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");
  mkdirSync(join(tmpHome, ".cursor"), { recursive: true });
  mkdirSync(join(tmpPkg, "cursor", "bundle"), { recursive: true });
  writeFileSync(join(tmpPkg, "cursor", "bundle", "session-start.js"), "// fake bundle");
  writeFileSync(join(tmpPkg, "cursor", "bundle", "capture.js"), "// fake bundle");
  writeFileSync(join(tmpPkg, "cursor", "bundle", "pre-tool-use.js"), "// fake bundle");
  writeFileSync(join(tmpPkg, "cursor", "bundle", "session-end.js"), "// fake bundle");
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "9.9.9" }));

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

async function importInstaller(): Promise<typeof import("../../src/cli/install-cursor.js")> {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-cursor.js");
}

describe("installCursor", () => {
  it("creates the bundle, writes hooks.json with all 7 cursor events, and stamps version", async () => {
    const { installCursor } = await importInstaller();
    installCursor();

    expect(existsSync(join(tmpHome, ".cursor", "hivemind", "bundle", "capture.js"))).toBe(true);
    expect(readFileSync(join(tmpHome, ".cursor", "hivemind", ".hivemind_version"), "utf-8")).toBe("9.9.9");

    const hooks = JSON.parse(readFileSync(join(tmpHome, ".cursor", "hooks.json"), "utf-8"));
    // Cursor events ship: sessionStart, beforeSubmitPrompt, preToolUse,
    // postToolUse, afterAgentResponse, stop, sessionEnd
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "afterAgentResponse", "beforeSubmitPrompt", "postToolUse",
      "preToolUse", "sessionEnd", "sessionStart", "stop",
    ]);
    expect(hooks.version).toBe(1);
    expect(hooks._hivemindManaged).toEqual({ version: "9.9.9" });
  });

  it("preToolUse entry carries the Shell matcher (intercepts grep against memory mount)", async () => {
    const { installCursor } = await importInstaller();
    installCursor();
    const hooks = JSON.parse(readFileSync(join(tmpHome, ".cursor", "hooks.json"), "utf-8"));
    const preToolUseEntries = hooks.hooks.preToolUse;
    expect(preToolUseEntries).toHaveLength(1);
    expect(preToolUseEntries[0].matcher).toBe("Shell");
  });

  it("preserves a user hook on a hivemind-claimed event (re-install over existing config)", async () => {
    // CLAUDE.md rule 12 — fixture that the data-loss bug would have wiped.
    const userHook = { command: "/usr/local/bin/my-pre-tool.sh", timeout: 4 };
    writeFileSync(
      join(tmpHome, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { postToolUse: [userHook] }, customField: "preserve me" }),
    );

    const { installCursor } = await importInstaller();
    installCursor();

    const hooks = JSON.parse(readFileSync(join(tmpHome, ".cursor", "hooks.json"), "utf-8"));
    expect(hooks.hooks.postToolUse).toHaveLength(2);
    expect(hooks.hooks.postToolUse[0]).toEqual(userHook);
    expect(hooks.customField).toBe("preserve me");
  });

  it("re-install over a config with a stale hivemind entry replaces, not duplicates", async () => {
    const stale = { command: `node "${join(tmpHome, ".cursor", "hivemind", "bundle", "old-capture.js")}"`, timeout: 99 };
    writeFileSync(
      join(tmpHome, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { postToolUse: [stale] } }),
    );

    const { installCursor } = await importInstaller();
    installCursor();

    const hooks = JSON.parse(readFileSync(join(tmpHome, ".cursor", "hooks.json"), "utf-8"));
    // Negative pattern: stale path is gone, replaced by the fresh capture.js.
    const cmds = hooks.hooks.postToolUse.map((e: { command: string }) => e.command);
    expect(cmds.some((c: string) => c.includes("old-capture.js"))).toBe(false);
    expect(cmds.some((c: string) => c.endsWith('capture.js"'))).toBe(true);
  });

  it("throws when the bundle source is missing (build hasn't run)", async () => {
    rmSync(join(tmpPkg, "cursor", "bundle"), { recursive: true, force: true });
    const { installCursor } = await importInstaller();
    expect(() => installCursor()).toThrow(/Cursor bundle missing/);
  });
});

describe("uninstallCursor", () => {
  it("removes hooks.json entirely when only hivemind hooks were present", async () => {
    const { installCursor, uninstallCursor } = await importInstaller();
    installCursor();
    uninstallCursor();
    expect(existsSync(join(tmpHome, ".cursor", "hooks.json"))).toBe(false);
  });

  it("logs a 'no hooks.json to clean' notice when nothing exists", async () => {
    const writes: string[] = [];
    (process.stdout.write as any).mockImplementation((s: string) => { writes.push(s); return true; });
    const { uninstallCursor } = await importInstaller();
    uninstallCursor();
    expect(writes.join("")).toContain("no hooks.json to clean");
  });

  it("preserves user hooks while stripping hivemind ones (mixed config)", async () => {
    const userHook = { command: "/usr/local/bin/audit.sh", timeout: 3 };
    const us = { command: `node "${join(tmpHome, ".cursor", "hivemind", "bundle", "capture.js")}"`, timeout: 15 };
    writeFileSync(
      join(tmpHome, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { postToolUse: [userHook, us] }, otherField: "stay" }),
    );

    const { uninstallCursor } = await importInstaller();
    uninstallCursor();

    const cfg = JSON.parse(readFileSync(join(tmpHome, ".cursor", "hooks.json"), "utf-8"));
    expect(cfg.hooks.postToolUse).toHaveLength(1);
    expect(cfg.hooks.postToolUse[0]).toEqual(userHook);
    expect(cfg.otherField).toBe("stay");
    expect(cfg._hivemindManaged).toBeUndefined();
  });

  it("removes the file when stripping leaves only the version field behind", async () => {
    // CLAUDE.md rule 7: cover both branches of the meaningfulKeys check —
    // the file must be removed even when version: 0 (falsy) sneaks through.
    const us = { command: `node "${join(tmpHome, ".cursor", "hivemind", "bundle", "capture.js")}"` };
    writeFileSync(
      join(tmpHome, ".cursor", "hooks.json"),
      JSON.stringify({ version: 0, hooks: { postToolUse: [us] } }),
    );
    const { uninstallCursor } = await importInstaller();
    uninstallCursor();
    expect(existsSync(join(tmpHome, ".cursor", "hooks.json"))).toBe(false);
  });
});
