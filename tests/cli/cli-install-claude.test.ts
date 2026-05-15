import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/cli/install-claude.ts.
 *
 * The installer delegates entirely to the `claude` CLI via execFileSync —
 * it has no filesystem side effects of its own. We mock node:child_process
 * at the boundary (CLAUDE.md rule 5) and assert SHAPE AND COUNT of the
 * spawned argv (rule 6) so the install vs. enable vs. uninstall branches
 * are pinned, and a regression that calls a wrong subcommand or skips
 * `enable` cannot slip through.
 */

const execFileSyncMock = vi.fn();
const stdoutWriteMock = vi.fn();
const stderrWriteMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

interface ExecCall {
  bin: string;
  args: string[];
}
function calls(): ExecCall[] {
  return execFileSyncMock.mock.calls.map(c => ({ bin: c[0] as string, args: c[1] as string[] }));
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(((...a: unknown[]) => { stdoutWriteMock(...a); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((...a: unknown[]) => { stderrWriteMock(...a); return true; }) as any);
  stdoutWriteMock.mockReset();
  stderrWriteMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importFresh(): Promise<typeof import("../../src/cli/install-claude.js")> {
  vi.resetModules();
  return await import("../../src/cli/install-claude.js");
}

// Helper: configure execFileSyncMock to behave like a real claude CLI
// returning specific stdout for each subcommand.
function setupClaudeResponses(opts: {
  versionOk?: boolean;
  marketplaceList?: string;
  pluginList?: string;
  marketplaceAddOk?: boolean;
  installOk?: boolean;
}): void {
  execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
    if (bin !== "claude") throw new Error(`unexpected bin: ${bin}`);
    if (args[0] === "--version") {
      if (opts.versionOk === false) throw new Error("not found");
      return "1.0.0";
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
      return opts.marketplaceList ?? "";
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return opts.pluginList ?? "";
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      if (opts.marketplaceAddOk === false) {
        const err = new Error("add failed");
        (err as { stderr?: Buffer }).stderr = Buffer.from("marketplace error");
        throw err;
      }
      return "added";
    }
    if (args[0] === "plugin" && args[1] === "install") {
      if (opts.installOk === false) {
        const err = new Error("install failed");
        (err as { stderr?: Buffer }).stderr = Buffer.from("install error");
        throw err;
      }
      return "installed";
    }
    if (args[0] === "plugin" && (args[1] === "enable" || args[1] === "disable" || args[1] === "uninstall")) {
      return "ok";
    }
    return "";
  });
}

describe("installClaude — preconditions", () => {
  it("throws a 'claude CLI not found' error when --version fails", async () => {
    setupClaudeResponses({ versionOk: false });
    const { installClaude } = await importFresh();
    expect(() => installClaude()).toThrow(/Claude Code CLI \('claude'\) not found on PATH/);
    // Only the --version probe ran; we did not advance to plugin commands.
    expect(calls()).toEqual([{ bin: "claude", args: ["--version"] }]);
  });

  it("propagates a clear error message when 'plugin marketplace add' fails", async () => {
    setupClaudeResponses({ marketplaceAddOk: false });
    const { installClaude } = await importFresh();
    expect(() => installClaude()).toThrow(/Failed to add marketplace 'activeloopai\/hivemind'/);
  });

  it("propagates a clear error message when 'plugin install' fails", async () => {
    setupClaudeResponses({ installOk: false });
    const { installClaude } = await importFresh();
    expect(() => installClaude()).toThrow(/Failed to install hivemind plugin/);
  });
});

describe("installClaude — happy path argv shape", () => {
  it("on cold install, runs --version, marketplace list, marketplace add, plugin list, plugin install, plugin enable (in this order, exactly once each)", async () => {
    setupClaudeResponses({});
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).toEqual([
      "--version",
      "plugin marketplace list",
      "plugin marketplace add activeloopai/hivemind",
      "plugin list",
      "plugin install hivemind",
      "plugin enable hivemind@hivemind",
    ]);
  });

  it("skips marketplace add when 'marketplace list' already includes 'hivemind'", async () => {
    setupClaudeResponses({ marketplaceList: "hivemind\nfoo\nbar" });
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).not.toContain("plugin marketplace add activeloopai/hivemind");
    // But still attempts plugin install + enable.
    expect(argvList).toContain("plugin install hivemind");
    expect(argvList).toContain("plugin enable hivemind@hivemind");
  });

  it("skips 'plugin install' AND triggers 'plugin update' across all 4 scopes when already installed", async () => {
    // When `plugin list` already shows the plugin, we no longer skip and
    // do nothing. We refresh the marketplace cache and run
    // `plugin update --scope X` for every scope so the user actually
    // gets the new version. Without this, `hivemind update`'s call into
    // installClaude() was a silent no-op for Claude.
    setupClaudeResponses({ pluginList: "hivemind@hivemind enabled" });
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).not.toContain("plugin install hivemind");
    expect(argvList).toContain("plugin marketplace update hivemind");
    // All four scopes must be exercised — `claude plugin update` is
    // per-scope, and we don't know which one the user has the plugin
    // activated under.
    expect(argvList).toContain("plugin update hivemind@hivemind --scope user");
    expect(argvList).toContain("plugin update hivemind@hivemind --scope project");
    expect(argvList).toContain("plugin update hivemind@hivemind --scope local");
    expect(argvList).toContain("plugin update hivemind@hivemind --scope managed");
    // And enable still fires (idempotent).
    expect(argvList).toContain("plugin enable hivemind@hivemind");
  });

  it("on already-installed: runs marketplace update BEFORE plugin update (cache must be fresh)", async () => {
    // Order matters — without `marketplace update` first, the `plugin
    // update` calls would resolve against a stale catalog and could
    // no-op even when a newer version is published.
    setupClaudeResponses({ pluginList: "hivemind@hivemind enabled" });
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    const refreshIdx = argvList.indexOf("plugin marketplace update hivemind");
    const firstUpdateIdx = argvList.findIndex(a => a.startsWith("plugin update hivemind@hivemind --scope"));
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIdx).toBeGreaterThan(refreshIdx);
  });

  it("on cold install: does NOT run 'plugin update' (no upgrade needed when freshly installed)", async () => {
    // Negative-pattern test (CLAUDE.md rule 8): a regression that ran
    // `plugin update` even on a cold install would waste cycles and
    // possibly misreport "refreshed" instead of "installed".
    setupClaudeResponses({});
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList.some(a => a.startsWith("plugin update hivemind@hivemind"))).toBe(false);
    expect(argvList).not.toContain("plugin marketplace update hivemind");
    expect(argvList).toContain("plugin install hivemind");
  });

  it("matches the marketplace name as a whole token, not a substring", async () => {
    // CLAUDE.md rule 8: regression — naive .includes("hivemind") would
    // match "hivemind-foo" and skip the genuine add. The real check is
    // \bhivemind\b on a per-line basis.
    setupClaudeResponses({ marketplaceList: "hivemind-other\nfoo" });
    const { installClaude } = await importFresh();
    installClaude();
    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).toContain("plugin marketplace add activeloopai/hivemind");
  });

  it("logs an installation success line to stdout", async () => {
    setupClaudeResponses({});
    const { installClaude } = await importFresh();
    installClaude();
    const out = stdoutWriteMock.mock.calls.map(c => c[0]).join("");
    expect(out).toContain("Claude Code");
    expect(out).toContain("activeloopai/hivemind");
  });
});

describe("installClaude — runClaude error stream fallbacks", () => {
  it("when execFileSync error has stderr buffer: that text is surfaced in the thrown message", async () => {
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === "--version") return "ok";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return "";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const err = new Error("nope");
        (err as { stderr?: Buffer }).stderr = Buffer.from("specific upstream error message");
        throw err;
      }
      return "";
    });
    const { installClaude } = await importFresh();
    expect(() => installClaude()).toThrow(/specific upstream error message/);
  });

  it("when execFileSync error has no stderr but a message: message is surfaced", async () => {
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === "--version") return "ok";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return "";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        throw new Error("only-message-no-stderr");
      }
      return "";
    });
    const { installClaude } = await importFresh();
    expect(() => installClaude()).toThrow(/only-message-no-stderr/);
  });

  it("'marketplace list' that exits non-zero returns false → installer falls through and runs 'add'", async () => {
    let addRan = false;
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === "--version") return "ok";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
        // Simulate "claude not signed in to fetch marketplace list" — non-zero exit.
        throw Object.assign(new Error("nope"), { stderr: Buffer.from("auth required") });
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") { addRan = true; return "ok"; }
      if (args[0] === "plugin" && args[1] === "list") return "";
      return "ok";
    });
    const { installClaude } = await importFresh();
    installClaude();
    expect(addRan).toBe(true);
  });

  it("'plugin list' that exits non-zero returns false → installer falls through and runs 'install'", async () => {
    let installRan = false;
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === "--version") return "ok";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return "hivemind\n";
      if (args[0] === "plugin" && args[1] === "list") {
        throw Object.assign(new Error("nope"), { stderr: Buffer.from("err") });
      }
      if (args[0] === "plugin" && args[1] === "install") { installRan = true; return "ok"; }
      return "ok";
    });
    const { installClaude } = await importFresh();
    installClaude();
    expect(installRan).toBe(true);
  });
});

describe("uninstallClaude", () => {
  it("runs disable then uninstall when claude CLI is on PATH", async () => {
    setupClaudeResponses({});
    const { uninstallClaude } = await importFresh();
    uninstallClaude();
    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).toEqual([
      "--version",
      "plugin disable hivemind@hivemind",
      "plugin uninstall hivemind@hivemind",
    ]);
  });

  it("logs a 'claude CLI not on PATH' notice and skips when --version fails", async () => {
    setupClaudeResponses({ versionOk: false });
    const { uninstallClaude } = await importFresh();
    uninstallClaude();
    const out = stdoutWriteMock.mock.calls.map(c => c[0]).join("");
    expect(out).toContain("claude CLI not on PATH");
    // Only --version was attempted, no destructive disable/uninstall.
    expect(calls().length).toBe(1);
  });
});


describe("cleanupBrokenSettingsHooks", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  let TEMP_HOME = "";
  let ORIGINAL_HOME: string | undefined;

  function writeSettings(s: unknown) {
    const dir = path.join(TEMP_HOME, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(s), "utf-8");
  }
  function readSettings(): any {
    return JSON.parse(fs.readFileSync(path.join(TEMP_HOME, ".claude", "settings.json"), "utf-8"));
  }
  function bundlePath(rel: string) {
    return path.join(TEMP_HOME, ".claude", "plugins", "hivemind", "bundle", rel);
  }
  function makeBrokenEntry(file: string) {
    return { type: "command", command: `node "${bundlePath(file)}"`, timeout: 10 };
  }

  beforeEach(() => {
    TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-cleanup-test-"));
    ORIGINAL_HOME = process.env.HOME;
    process.env.HOME = TEMP_HOME;
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  it("returns {removed:0} when settings.json does not exist", async () => {
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks()).toEqual({ removed: 0, events: [] });
  });

  it("returns {removed:0} when settings.json has no hooks key", async () => {
    writeSettings({ unrelated: "field" });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks()).toEqual({ removed: 0, events: [] });
  });

  it("returns {removed:0} when settings.json is malformed (no-op, file untouched)", async () => {
    fs.mkdirSync(path.join(TEMP_HOME, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(TEMP_HOME, ".claude", "settings.json"), "{not-json", "utf-8");
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks()).toEqual({ removed: 0, events: [] });
    expect(fs.readFileSync(path.join(TEMP_HOME, ".claude", "settings.json"), "utf-8")).toBe("{not-json");
  });

  it("returns {removed:0} when settings.json is literally 'null' (CodeRabbit PR#166)", async () => {
    // JSON.parse("null") returns null without throwing — dereferencing
    // `.hooks` would crash. Regression guard for the post-parse null check.
    fs.mkdirSync(path.join(TEMP_HOME, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(TEMP_HOME, ".claude", "settings.json"), "null", "utf-8");
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(() => cleanupBrokenSettingsHooks()).not.toThrow();
    expect(cleanupBrokenSettingsHooks()).toEqual({ removed: 0, events: [] });
  });

  it("returns {removed:0} when settings.json is a JSON primitive (string/number/bool)", async () => {
    // Other JSON.parse non-object outputs: "5", "\"x\"", "true". All valid
    // JSON, none usable as a SettingsShape.
    fs.mkdirSync(path.join(TEMP_HOME, ".claude"), { recursive: true });
    for (const literal of ["5", "\"some-string\"", "true", "[]"]) {
      fs.writeFileSync(path.join(TEMP_HOME, ".claude", "settings.json"), literal, "utf-8");
      const { cleanupBrokenSettingsHooks } = await importFresh();
      expect(() => cleanupBrokenSettingsHooks(), `failed for literal ${literal}`).not.toThrow();
      expect(cleanupBrokenSettingsHooks()).toEqual({ removed: 0, events: [] });
    }
  });

  it("removes a hook entry whose legacy path points at a non-existent file", async () => {
    // Path is in the legacy fragment AND the file doesn't exist → remove.
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [
          makeBrokenEntry("session-notifications.js"),
        ] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(1);
    expect(r.events).toEqual(["SessionStart"]);
    // Empty matcher block was dropped (no orphan empty hooks array).
    const s = readSettings();
    expect(s.hooks.SessionStart).toEqual([]);
  });

  it("PRESERVES a legacy-path hook entry whose file actually exists", async () => {
    // Legitimate legacy install: path is legacy-style, file exists on disk → keep.
    const bundleDir = path.join(TEMP_HOME, ".claude", "plugins", "hivemind", "bundle");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "session-start.js"), "// real legacy bundle", "utf-8");

    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [
          makeBrokenEntry("session-start.js"),
        ] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(0);
    expect(readSettings().hooks.SessionStart[0].hooks).toHaveLength(1);
  });

  it("PRESERVES marketplace-style entries with ${CLAUDE_PLUGIN_ROOT}", async () => {
    // These are the correct, runtime-resolved entries. Don't touch.
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [
          { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/bundle/session-start.js"', timeout: 10 },
        ] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(0);
    expect(readSettings().hooks.SessionStart[0].hooks).toHaveLength(1);
  });

  it("PRESERVES non-hivemind entries unconditionally", async () => {
    writeSettings({
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [
          { type: "command", command: "/usr/local/bin/lint-bash" },
        ] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(0);
    expect(readSettings().hooks.PostToolUse[0].hooks).toHaveLength(1);
  });

  it("removes broken hivemind entries while preserving non-hivemind in the same matcher", async () => {
    writeSettings({
      hooks: {
        PostToolUse: [{ hooks: [
          { type: "command", command: "/usr/local/bin/some-other-tool" }, // keep
          makeBrokenEntry("capture.js"),                                   // remove
        ] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(1);
    expect(r.events).toEqual(["PostToolUse"]);
    const remaining = readSettings().hooks.PostToolUse[0].hooks;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].command).toBe("/usr/local/bin/some-other-tool");
  });

  it("removes broken entries across multiple events in one pass", async () => {
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [makeBrokenEntry("session-notifications.js")] }],
        SessionEnd:   [{ hooks: [makeBrokenEntry("session-end.js")] }],
        PostToolUse:  [{ hooks: [makeBrokenEntry("capture.js")] }],
      },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r = cleanupBrokenSettingsHooks();
    expect(r.removed).toBe(3);
    expect(r.events.sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart"]);
  });

  it("is idempotent — second call after first cleanup is a no-op", async () => {
    writeSettings({
      hooks: { SessionStart: [{ hooks: [makeBrokenEntry("session-notifications.js")] }] },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    const r1 = cleanupBrokenSettingsHooks();
    expect(r1.removed).toBe(1);
    const r2 = cleanupBrokenSettingsHooks();
    expect(r2.removed).toBe(0);
  });

  it("handles non-string command field gracefully", async () => {
    writeSettings({
      hooks: { SessionStart: [{ hooks: [
        { type: "command", command: null, timeout: 10 },
      ] }] },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks().removed).toBe(0);
  });

  it("handles Windows-style backslash paths (defensive)", async () => {
    // The buggy helper could have produced Windows-style paths on Windows.
    // Cleanup must recognize them by normalizing backslashes.
    writeSettings({
      hooks: { SessionStart: [{ hooks: [{
        type: "command",
        command: `node "${TEMP_HOME}\\.claude\\plugins\\hivemind\\bundle\\session-notifications.js"`,
        timeout: 5,
      }] }] },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    // Cleanup only fires if the path doesn't exist; on Linux this Windows-style
    // path won't exist either way, so the broken-entry detection should fire.
    expect(cleanupBrokenSettingsHooks().removed).toBe(1);
  });

  it("does NOT touch matcher blocks with no hooks array (malformed but harmless)", async () => {
    writeSettings({
      hooks: { SessionStart: [{ /* no hooks key */ } as any] },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks().removed).toBe(0);
    // Matcher block preserved verbatim.
    expect(readSettings().hooks.SessionStart).toHaveLength(1);
  });

  it("does NOT touch events whose value is not an array (defensive)", async () => {
    writeSettings({
      hooks: { SessionStart: "not-an-array" as any },
    });
    const { cleanupBrokenSettingsHooks } = await importFresh();
    expect(cleanupBrokenSettingsHooks().removed).toBe(0);
  });
});
