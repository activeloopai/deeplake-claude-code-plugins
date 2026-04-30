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

  it("skips plugin install when 'plugin list' already includes 'hivemind@hivemind'", async () => {
    setupClaudeResponses({ pluginList: "hivemind@hivemind enabled" });
    const { installClaude } = await importFresh();
    installClaude();

    const argvList = calls().map(c => c.args.join(" "));
    expect(argvList).not.toContain("plugin install hivemind");
    expect(argvList).toContain("plugin enable hivemind@hivemind");
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
