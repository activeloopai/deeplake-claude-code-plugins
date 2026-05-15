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

let stdoutMock: any;
let stderrMock: any;

beforeEach(() => {
  stdoutMock = vi.fn();
  stderrMock = vi.fn();
  vi.spyOn(process.stdout, "write").mockImplementation(((...a: unknown[]) => { stdoutMock(...a); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((...a: unknown[]) => { stderrMock(...a); return true; }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stdoutText = () => stdoutMock.mock.calls.map((c: any) => c[0]).join("");
const stderrText = () => stderrMock.mock.calls.map((c: any) => c[0]).join("");

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

  it("dry-run, npm-global: prints 'Would run npm install -g' + 'Would re-run hivemind install', no spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npm-global", installDir: "/usr/lib/node_modules/@deeplake/hivemind" },
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("Update available: 1.2.3 → 1.3.0");
    expect(stdoutText()).toContain("(dry-run) Would run: npm install -g @deeplake/hivemind@latest");
    expect(stdoutText()).toContain("(dry-run) Would re-run: hivemind install --skip-auth");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dry-run, npx: prints 'Would print npx-pin instructions', no spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "npx", installDir: "/home/u/.npm/_npx/abc/node_modules/@deeplake/hivemind" },
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("(dry-run)");
    expect(stdoutText()).toContain("npx-pin");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dry-run, local-dev: prints 'Would refuse: running from a local dev checkout', no spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "local-dev", installDir: "/home/u/al-projects/hivemind" },
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("(dry-run) Would refuse");
    expect(stdoutText()).toContain("local dev checkout");
    expect(stdoutText()).toContain("/home/u/al-projects/hivemind");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dry-run, unknown: prints 'Would refuse: install kind unknown', no spawn", async () => {
    const spawn = vi.fn();
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      installKindOverride: { kind: "unknown", installDir: "/strange/path" },
      spawn,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("(dry-run) Would refuse");
    expect(stdoutText()).toContain("install kind unknown");
    expect(stdoutText()).toContain("/strange/path");
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

  // Drives the live-fetch fallback (ternary at `latestVersionOverride !==
  // undefined ? ... : await getLatestNpmVersion()`) AND the
  // `currentVersionOverride ?? getVersion()` fallback at the same time.
  // Mocked at the fetch boundary to avoid network. Mocks fetch to return
  // the SAME version as the running package.json so we land in
  // "up to date" and don't dispatch into any spawn branch.
  it("falls through to live getVersion + getLatestNpmVersion when both overrides are omitted", async () => {
    // Read the actual installed version so the mock matches and we hit
    // the "up to date" branch deterministically.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repoRoot = process.cwd();
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    const version: string = pkg.version;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version }), { status: 200 }),
    );
    const code = await runUpdate({
      // NO currentVersionOverride → exercises getVersion()
      // NO latestVersionOverride → exercises getLatestNpmVersion()
    });
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(stdoutText()).toContain("up to date");
    fetchSpy.mockRestore();
  });

  // Drives the `installKindOverride ?? detectInstallKind()` fallback —
  // omits installKindOverride so the real detection runs against this
  // test process. The result is local-dev (we're inside a git checkout).
  it("falls through to live detectInstallKind when installKindOverride is omitted", async () => {
    const code = await runUpdate({
      currentVersionOverride: "1.2.3",
      latestVersionOverride: "1.3.0",
      // NO installKindOverride → exercises detectInstallKind()
    });
    // detectInstallKind() in this test process lands in local-dev
    // (the worktree has a .git linkage) → exit 1 + refuse.
    expect(code).toBe(1);
    expect(stderrText()).toMatch(/local development checkout|Could not determine/);
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
    // NOTE: this repo's CI images may have `/tmp/.git`, which would make the
    // `.git`-reachable heuristic misclassify arbitrary tmp paths as local-dev.
    // The production probe only walks 6 levels; nest the fake install deeply
    // enough that it cannot reach `/tmp/.git`.
    const deepPrefix = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"];
    const installDir = join(TMP, ...deepPrefix, ...opts.pathSegments);
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

  // Regression: an npm-global install whose grandparent dir contains .git
  // (e.g. nvm-installed-via-git → ~/.nvm/.git → ~/.nvm/versions/node/v24/lib/node_modules/@deeplake/hivemind)
  // must NOT be classified as local-dev. The path-based npm-global match
  // takes priority over the .git-reachable probe.
  it("npm-global wins over local-dev when both heuristics would fire", () => {
    const argv1 = fakeInstall({
      pathSegments: ["versions", "node", "v24.12.0", "lib", "node_modules", "@deeplake", "hivemind"],
      pkgName: "@deeplake/hivemind",
    });
    // Drop a .git that's reachable from a parent of installDir, to mimic
    // the nvm-via-git layout.
    mkdirSync(join(TMP, ".git"), { recursive: true });
    expect(detectInstallKind(argv1).kind).toBe("npm-global");
  });

  // Same regression for npx — path-based check wins over .git probe.
  it("npx wins over local-dev when both heuristics would fire", () => {
    const argv1 = fakeInstall({
      pathSegments: ["_npx", "abc123", "node_modules", "@deeplake", "hivemind"],
      pkgName: "@deeplake/hivemind",
    });
    mkdirSync(join(TMP, ".git"), { recursive: true });
    expect(detectInstallKind(argv1).kind).toBe("npx");
  });

  // Walk-up loop: the package.json walk caps at 10 levels. If the install
  // is deeper than that, we still get *a* result (fall back to argv1's
  // dirname as installDir) — just won't find package.json.
  it("returns a result even when no package.json is reachable in 10 levels", () => {
    const argv1 = fakeInstall({
      pathSegments: ["random", "place"],
    });
    // Don't write any package.json — force the walk-up to exhaust.
    const got = detectInstallKind(argv1);
    expect(got.kind).toBe("unknown");
    expect(got.installDir).toBeTruthy();
  });

  // realpathSync throws on a non-existent path → catch falls back to the
  // raw argv1. Covers the catch branch in the realpath wrapper.
  it("falls back to raw argv1 when realpath throws (path doesn't exist)", () => {
    const fakePath = "/this/path/does/not/exist/_npx/x/node_modules/@deeplake/hivemind/bundle/cli.js";
    const got = detectInstallKind(fakePath);
    // Path-pattern checks still work against the raw string — should land
    // in npx (the path contains `_npx`).
    expect(got.kind).toBe("npx");
  });

  // Walks up to filesystem root without finding our package.json: covers
  // the `parent === dir` break branch in the walk-up loop. We use the
  // root path itself, so dir starts at "/" and break fires immediately.
  it("walk-up handles the filesystem-root edge case", () => {
    // dirname("/") is "/", so the loop's break-on-no-progress fires.
    expect(() => detectInstallKind("/cli.js")).not.toThrow();
  });
});

// Real defaultSpawn path: passing no `spawn` override exercises the real
// execFileSync. We can't actually run npm in the test, but we can prove
// the default impl gets reached on the failure path. CodeRabbit flagged
// the absence of coverage for this fallback; this drives the line.
describe("runUpdate — default spawn", () => {
  it("invokes the default spawn (execFileSync) when no override is passed", async () => {
    // npm-global path with a guaranteed-to-fail command via PATH override.
    // We can't override the real spawn here, so we exercise the npm-global
    // branch which calls into defaultSpawn → execFileSync('npm', ...).
    // execFileSync will fail because PATH doesn't have a real npm in the
    // test sandbox (or the install will succeed against a valid registry —
    // either way the line is executed and counted).
    //
    // Skip if we're in CI where npm IS installed; the test would actually
    // try to upgrade. Use a dry-run kind override that hits the npx branch
    // to avoid that: npx branch never spawns, so default isn't reached.
    //
    // Better: exercise the dry-run for npm-global, which goes through the
    // dry-run branch (no spawn). That doesn't hit defaultSpawn either.
    //
    // The simplest deterministic exercise of defaultSpawn: install kind
    // override = npm-global, NO dry-run, and override spawn AS the default
    // by NOT passing it. But then we'd actually fork npm install -g, which
    // is destructive. So we mock out npm via PATH.
    const originalPath = process.env.PATH;
    process.env.PATH = "/this/path/does/not/exist/anywhere";
    try {
      const code = await runUpdate({
        currentVersionOverride: "1.2.3",
        latestVersionOverride: "1.3.0",
        installKindOverride: { kind: "npm-global", installDir: "/x" },
        // NO spawn override — exercise defaultSpawn
      });
      // npm not on PATH → execFileSync throws ENOENT → npm-install branch
      // returns 1.
      expect(code).toBe(1);
      expect(stderrText()).toContain("npm install failed");
    } finally {
      process.env.PATH = originalPath;
    }
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
