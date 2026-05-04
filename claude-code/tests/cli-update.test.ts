import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for src/cli/update.ts — the unified `hivemind update` command.
 *
 * The update flow has three branches we care about:
 *   1. up-to-date          → log + exit 0
 *   2. update available    → npm install -g + re-exec install
 *   3. install kind != npm → user instructions, no spawn
 *
 * Tests use `latestVersionOverride`, `currentVersionOverride`, and
 * `installKindOverride` to drive each branch deterministically without
 * touching the network or fork()ing npm. The `spawn` injector lets us
 * assert on COUNT and SHAPE of the commands we'd run (CLAUDE.md rule 6).
 */

import { runUpdate, detectInstallKind, getLatestNpmVersion } from "../../src/cli/update.js";

let stdoutMock: ReturnType<typeof vi.fn>;
let stderrMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stdoutMock = vi.fn();
  stderrMock = vi.fn();
  vi.spyOn(process.stdout, "write").mockImplementation(((...a: unknown[]) => { stdoutMock(...a); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((...a: unknown[]) => { stderrMock(...a); return true; }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stdoutText = () => stdoutMock.mock.calls.map(c => c[0]).join("");
const stderrText = () => stderrMock.mock.calls.map(c => c[0]).join("");

describe("runUpdate — branches", () => {
  it("exits 0 with 'up to date' when latest equals current", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.2.3",
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("up to date");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("exits 0 with 'up to date' when current is ahead of registry", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.4",
      latestVersionOverride: "1.2.3",
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("up to date");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("exits 1 with a warning when registry can't be reached", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: null,
      spawn,
    });
    expect(code).toBe(1);
    expect(stderrText()).toContain("Could not reach npm registry");
    expect(stderrText()).toContain("1.2.3");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dry-run: prints 'Would run' and 'Would re-run' without spawning", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("Update available: 1.2.3 → 1.3.0");
    expect(stdoutText()).toContain("(dry-run) Would run: npm install -g @deeplake/hivemind@latest");
    expect(stdoutText()).toContain("(dry-run) Would re-run: hivemind install --skip-auth");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("npm-global: spawns 'npm install -g @latest' THEN 'hivemind install --skip-auth' (in that order, exactly once each)", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npm-global", installDir: "/usr/lib/node_modules/@deeplake/hivemind" },
      spawn,
    });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]).toEqual(["npm", ["install", "-g", "@deeplake/hivemind@latest"]]);
    expect(spawn.mock.calls[1]).toEqual(["hivemind", ["install", "--skip-auth"]]);
    expect(stdoutText()).toContain("Updated to 1.3.0");
  });

  it("npm-global: returns 1 if `npm install` itself fails (does NOT attempt the refresh)", async () => {
    const spawn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "npm") throw new Error("ENOENT");
    });
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npm-global", installDir: "/x" },
      spawn,
    });
    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stderrText()).toContain("npm install failed: ENOENT");
  });

  it("npm-global: returns 1 if the post-install agent refresh fails", async () => {
    const spawn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "hivemind") throw new Error("missing platforms");
    });
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npm-global", installDir: "/x" },
      spawn,
    });
    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(stderrText()).toContain("Agent refresh failed");
  });

  it("npx: prints versioned-pin instructions, returns 0, does NOT spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npx", installDir: "/home/u/.npm/_npx/abc/node_modules/@deeplake/hivemind" },
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("npx @deeplake/hivemind@1.3.0 install");
    expect(stdoutText()).toContain("npm install -g @deeplake/hivemind@latest");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("local-dev: refuses with a clear message, returns 1, does NOT spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "local-dev", installDir: "/home/u/al-projects/hivemind" },
      spawn,
    });
    expect(code).toBe(1);
    expect(stderrText()).toContain("local development checkout");
    expect(stderrText()).toContain("/home/u/al-projects/hivemind");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("unknown: refuses with manual-install fallback, returns 1, does NOT spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "unknown", installDir: "/strange/path" },
      spawn,
    });
    expect(code).toBe(1);
    expect(stderrText()).toContain("Could not determine how hivemind was installed");
    expect(stderrText()).toContain("npm install -g @deeplake/hivemind@latest");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("detectInstallKind — heuristics", () => {
  let TMP = "";
  beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), "hivemind-update-test-")); });
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

  // Build a fake install layout that points argv[1] at a fake CLI binary
  // and fake the surrounding directory tree. Each test exercises ONE
  // heuristic in isolation so a regression in one branch can't be hidden by
  // another (CLAUDE.md rule 7: cover both branches of conditional logic).
  function fakeInstall(opts: {
    pathSegments: string[];        // path under TMP, e.g. ["lib","node_modules","@deeplake","hivemind"]
    pkgName?: string;              // package.json name field
    addGitIn?: string[];           // create .git in this subpath of installDir
  }): string {
    const installDir = join(TMP, ...opts.pathSegments);
    mkdirSync(installDir, { recursive: true });
    if (opts.pkgName) {
      writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: opts.pkgName, version: "0.0.0" }));
    }
    if (opts.addGitIn) {
      mkdirSync(join(installDir, ...opts.addGitIn, ".git"), { recursive: true });
    }
    const binDir = join(installDir, "bundle");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "cli.js");
    writeFileSync(bin, "// fake");
    return bin;
  }

  it("identifies a local-dev checkout (.git present in a parent)", () => {
    const argv1 = fakeInstall({
      pathSegments: ["repo"],
      pkgName: "@deeplake/hivemind",
      addGitIn: [],
    });
    expect(detectInstallKind(argv1).kind).toBe("local-dev");
  });

  it("identifies an npm-global install (node_modules/@deeplake/hivemind, no .git)", () => {
    const argv1 = fakeInstall({
      pathSegments: ["lib", "node_modules", "@deeplake", "hivemind"],
      pkgName: "@deeplake/hivemind",
    });
    const got = detectInstallKind(argv1);
    expect(got.kind).toBe("npm-global");
  });

  it("identifies an npx install (path contains _npx, no .git)", () => {
    const argv1 = fakeInstall({
      pathSegments: ["_npx", "abc123", "node_modules", "@deeplake", "hivemind"],
      pkgName: "@deeplake/hivemind",
    });
    const got = detectInstallKind(argv1);
    expect(got.kind).toBe("npx");
  });

  it("returns 'unknown' when no marker matches", () => {
    const argv1 = fakeInstall({
      pathSegments: ["random", "place"],
    });
    expect(detectInstallKind(argv1).kind).toBe("unknown");
  });
});

describe("getLatestNpmVersion", () => {
  it("returns the version on a 200 response with a parseable body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
    );
    const got = await getLatestNpmVersion();
    expect(got).toBe("9.9.9");
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("returns null on non-200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    expect(await getLatestNpmVersion()).toBeNull();
    fetchSpy.mockRestore();
  });

  it("returns null on a network failure (caught, never throws)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await getLatestNpmVersion()).toBeNull();
    fetchSpy.mockRestore();
  });

  it("returns null when the response is missing 'version'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "x" }), { status: 200 }),
    );
    expect(await getLatestNpmVersion()).toBeNull();
    fetchSpy.mockRestore();
  });
});
