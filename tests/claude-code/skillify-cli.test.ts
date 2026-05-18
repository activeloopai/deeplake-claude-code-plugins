import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Mock the loadConfig + DeeplakeApi so the pull subcommand can run without
// hitting the network. The mock returns a fake row from the skills table.
// loadConfig is a vi.fn so individual tests can swap in null (unauthenticated)
// to exercise the unpull login-gating path.
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    async query(_sql: string) {
      return [{
        name: "fake-skill", project: "p", project_key: "pk",
        body: "body", version: 1, source_agent: "claude_code",
        scope: "me", author: "alice", description: "d",
        trigger_text: "", source_sessions: "[]", install: "global",
        created_at: "2026-01-01", updated_at: "2026-01-01",
      }];
    }
  },
}));

import { runSkillifyCommand } from "../../src/commands/skillify.js";
import { loadConfig } from "../../src/config.js";
const loadConfigMock = loadConfig as unknown as ReturnType<typeof vi.fn>;

const VALID_CONFIG = {
  token: "tok", apiUrl: "x", orgId: "org", workspaceId: "ws",
  userName: "tester", skillsTableName: "skills",
  tableName: "memory", sessionsTableName: "sessions", memoryPath: "/m",
  orgName: "org",
};

const STATE_DIR = join(homedir(), ".deeplake", "state", "skillify");
const CONFIG_PATH = join(STATE_DIR, "config.json");
let configBackup: string | null = null;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logged: string[] = [];
let erred: string[] = [];
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  if (existsSync(CONFIG_PATH)) configBackup = readFileSync(CONFIG_PATH, "utf-8");
  else configBackup = null;
  try { rmSync(CONFIG_PATH); } catch { /* nothing */ }
  logged = []; erred = [];
  // Default: logged in. Individual tests can `loadConfigMock.mockReturnValueOnce(null)`
  // to exercise the unauthenticated path of unpull (no login needed) vs --not-mine
  // (which still requires myUsername).
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue(VALID_CONFIG);
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => { logged.push(args.join(" ")); });
  errSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => { erred.push(args.join(" ")); });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`__EXIT_${code ?? 0}__`); }) as any);
});

afterEach(() => {
  // Restore cwd before any temp-dir cleanup happens — some tests do
  // `process.chdir(tempDir)` then `rmSync(tempDir)` later, leaving us in
  // a stale cwd that breaks subsequent tests' relative-path operations.
  try { process.chdir(originalCwd); } catch { /* nothing */ }
  if (configBackup !== null) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(CONFIG_PATH, configBackup); }
  else try { rmSync(CONFIG_PATH); } catch { /* nothing */ }
  logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
});

function expectExit(code: number, fn: () => void): void {
  expect(fn).toThrow(new RegExp(`__EXIT_${code}__`));
}

// ── status (default) ──────────────────────────────────────────────────────

describe("status (default subcommand)", () => {
  it("prints scope, team, install when config is empty", () => {
    runSkillifyCommand([]);
    const out = logged.join("\n");
    expect(out).toMatch(/scope:\s+me/);
    expect(out).toMatch(/team:\s+\(empty\)/);
    expect(out).toMatch(/install:\s+project/);
  });

  it("`status` subcommand alias", () => {
    runSkillifyCommand(["status"]);
    expect(logged.join("\n")).toMatch(/scope:/);
  });

  it("does NOT count config.json or pulled.json as tracked projects", () => {
    // Both files live in the same STATE_DIR but are skillify's own bookkeeping;
    // counting them would inflate "N project(s) tracked" and the parse loop
    // below would JSON.parse the wrong shape and silently swallow the error.
    const stateHome = mkdtempSync(join(tmpdir(), "skillify-cli-status-"));
    const prevHome = process.env.HOME;
    process.env.HOME = stateHome;
    try {
      const stateDir = join(stateHome, ".deeplake", "state", "skillify");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "config.json"), JSON.stringify({ scope: "me", team: [], install: "global" }));
      writeFileSync(join(stateDir, "pulled.json"), JSON.stringify({ version: 1, entries: [] }));
      logged = [];
      runSkillifyCommand([]);
      const out = logged.join("\n");
      expect(out).toMatch(/state: \(no projects tracked yet\)/);
      expect(out).not.toMatch(/project\(s\) tracked/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

// ── scope ─────────────────────────────────────────────────────────────────

describe("scope", () => {
  it("sets scope=team", () => {
    runSkillifyCommand(["scope", "team"]);
    expect(logged.join("\n")).toMatch(/Scope set to 'team'/);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).scope).toBe("team");
  });

  it("warns when scope=team but team list is empty", () => {
    runSkillifyCommand(["scope", "team"]);
    expect(logged.join("\n")).toMatch(/team list is empty/);
  });

  it("rejects invalid scope", () => {
    expectExit(1, () => runSkillifyCommand(["scope", "bogus"]));
    expect(erred.join("\n")).toMatch(/Invalid scope 'bogus'/);
  });

  it("rejects empty scope arg", () => {
    expectExit(1, () => runSkillifyCommand(["scope", ""]));
  });
});

// ── install ───────────────────────────────────────────────────────────────

describe("install", () => {
  it("sets install=global", () => {
    runSkillifyCommand(["install", "global"]);
    expect(logged.join("\n")).toMatch(/Install location set to 'global'/);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).install).toBe("global");
  });

  it("sets install=project", () => {
    runSkillifyCommand(["install", "project"]);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).install).toBe("project");
  });

  it("rejects invalid install location", () => {
    expectExit(1, () => runSkillifyCommand(["install", "weird"]));
  });
});

// ── team ──────────────────────────────────────────────────────────────────

describe("team", () => {
  it("adds, lists, removes a member", () => {
    runSkillifyCommand(["team", "add", "alice"]);
    expect(logged.join("\n")).toMatch(/Added 'alice'/);

    logged.length = 0;
    runSkillifyCommand(["team", "list"]);
    expect(logged.join("\n")).toMatch(/^alice$/m);

    logged.length = 0;
    runSkillifyCommand(["team", "remove", "alice"]);
    expect(logged.join("\n")).toMatch(/Removed 'alice'/);
  });

  it("dedupes when adding an existing name", () => {
    runSkillifyCommand(["team", "add", "alice"]);
    logged.length = 0;
    runSkillifyCommand(["team", "add", "alice"]);
    expect(logged.join("\n")).toMatch(/already in the team list/);
  });

  it("no-ops when removing a non-existent name", () => {
    runSkillifyCommand(["team", "remove", "ghost"]);
    expect(logged.join("\n")).toMatch(/not in the team list/);
  });

  it("team list when empty prints sentinel", () => {
    runSkillifyCommand(["team", "list"]);
    expect(logged.join("\n")).toMatch(/empty/);
  });

  it("rejects unknown team action", () => {
    expectExit(1, () => runSkillifyCommand(["team", "bogus"]));
  });

  it("rejects team add with no name", () => {
    expectExit(1, () => runSkillifyCommand(["team", "add"]));
  });

  it("rejects team remove with no name", () => {
    expectExit(1, () => runSkillifyCommand(["team", "remove"]));
  });
});

// ── promote ───────────────────────────────────────────────────────────────

describe("promote", () => {
  it("rejects empty skill name", () => {
    expectExit(1, () => runSkillifyCommand(["promote"]));
  });

  it("errors when project skill is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillify-cli-"));
    process.chdir(dir);
    expectExit(1, () => runSkillifyCommand(["promote", "nonexistent-skill"]));
    expect(erred.join("\n")).toMatch(/not found/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── pull ──────────────────────────────────────────────────────────────────

describe("pull", () => {
  it("runs --dry-run and prints summary", async () => {
    runSkillifyCommand(["pull", "--dry-run"]);
    // Async — wait for promise tail
    await new Promise(r => setImmediate(r));
    const out = logged.join("\n");
    expect(out).toMatch(/Destination:/);
    expect(out).toMatch(/Filter:\s+all users/);
    expect(out).toMatch(/dry-run/);
  });

  it("--to global is default destination", async () => {
    runSkillifyCommand(["pull", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(/Destination:.*\.claude\/skills/);
  });

  it("--to project lands files in cwd/.claude/skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skillify-cli-pull-"));
    process.chdir(dir);
    runSkillifyCommand(["pull", "--to", "project", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(new RegExp(`Destination:\\s+${dir}/.claude/skills`));
    rmSync(dir, { recursive: true, force: true });
  });

  it("--user X filters by single author", async () => {
    runSkillifyCommand(["pull", "--user", "alice", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(/Filter:\s+alice/);
  });

  it("--users a,b,c filters by multiple authors", async () => {
    runSkillifyCommand(["pull", "--users", "alice,bob,carol", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(/Filter:\s+alice, bob, carol/);
  });

  it("--all-users explicitly filters by no author", async () => {
    runSkillifyCommand(["pull", "--all-users", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(/Filter:\s+all users/);
  });

  it("positional skill-name flows into the filter", async () => {
    runSkillifyCommand(["pull", "fake-skill", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(logged.join("\n")).toMatch(/skill='fake-skill'/);
  });

  // Note: validation errors inside pullSkills (e.g. --to weird, --user
  // without value) call process.exit() asynchronously inside a fire-
  // and-forget promise, so they can't be caught from a sync test.
  // The validation logic itself is exercised by direct pull.test.ts tests
  // (buildPullSql, resolvePullDestination).
});

// ── unpull ────────────────────────────────────────────────────────────────

describe("unpull", () => {
  // Each test runs under a fresh HOME so the manifest writes by
  // pull/unpull don't pollute the developer's real ~/.deeplake state.
  let unpullHome: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    unpullHome = mkdtempSync(join(tmpdir(), "skillify-cli-unpull-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = unpullHome;
  });
  afterEach(() => {
    try { rmSync(unpullHome, { recursive: true, force: true }); } catch { /* nothing */ }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("--dry-run on empty manifest reports zero work", () => {
    runSkillifyCommand(["unpull", "--dry-run"]);
    const out = logged.join("\n");
    expect(out).toMatch(/Scanning:/);
    expect(out).toMatch(/Filter:\s+dry-run/);
    expect(out).toMatch(/Result: 0 removed, 0 dry-run, 0 kept\./);
  });

  it("default filter description is 'no filter — all pulled'", () => {
    runSkillifyCommand(["unpull"]);
    expect(logged.join("\n")).toMatch(/Filter:\s+\(no filter — all pulled\)/);
  });

  it("composes manifest-only filter flags into the filter description", () => {
    // --all and --legacy-cleanup are mutually exclusive with --user/--users
    // /--not-mine (see filter+all conflict guard), so the manifest-only
    // path is the right surface to assert flag composition on.
    runSkillifyCommand(["unpull", "--user", "alice", "--not-mine", "--dry-run"]);
    const out = logged.join("\n");
    expect(out).toMatch(/users=alice/);
    expect(out).toMatch(/not-mine/);
    expect(out).toMatch(/dry-run/);
  });

  it("composes disk-walk flags into the filter description", () => {
    runSkillifyCommand(["unpull", "--all", "--legacy-cleanup", "--dry-run"]);
    const out = logged.join("\n");
    expect(out).toMatch(/all/);
    expect(out).toMatch(/legacy-cleanup/);
    expect(out).toMatch(/dry-run/);
  });

  it("--users a,b,c parses CSV into the filter", () => {
    runSkillifyCommand(["unpull", "--users", "alice,bob,carol", "--dry-run"]);
    expect(logged.join("\n")).toMatch(/users=alice,bob,carol/);
  });

  it("--to project scopes the scanning root to cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillify-cli-unpull-proj-"));
    process.chdir(dir);
    runSkillifyCommand(["unpull", "--to", "project", "--dry-run"]);
    expect(logged.join("\n")).toMatch(new RegExp(`Scanning:\\s+${dir}/.claude/skills`));
    rmSync(dir, { recursive: true, force: true });
  });

  it("--to with invalid value reports error", async () => {
    // unpullSkills throws on bad input; the dispatcher's `.catch` logs
    // the message via console.error and exits 1.
    runSkillifyCommand(["unpull", "--to", "weird"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).toMatch(/Invalid --to/);
  });

  it("integrates with pull: round-trip clears manifest + disk", async () => {
    // 1. pull populates manifest + disk
    runSkillifyCommand(["pull", "--user", "alice", "--to", "global"]);
    await new Promise(r => setImmediate(r));
    const out1 = logged.join("\n");
    expect(out1).toMatch(/1 written/);
    logged = [];

    // 2. unpull clears it
    runSkillifyCommand(["unpull", "--user", "alice"]);
    const out2 = logged.join("\n");
    expect(out2).toMatch(/1 removed/);
    expect(out2).toMatch(/fake-skill--alice/);

    // 3. re-running unpull is idempotent (no entries, no errors)
    logged = [];
    runSkillifyCommand(["unpull"]);
    expect(logged.join("\n")).toMatch(/Scanned 0 dir\(s\)/);
  });

  it("emits 'manifest-pruned' tag when an entry's directory is missing on disk", async () => {
    // pull installs a skill, then we delete its dir out-of-band so the
    // manifest entry becomes an orphan
    runSkillifyCommand(["pull", "--user", "alice", "--to", "global"]);
    await new Promise(r => setImmediate(r));
    rmSync(join(unpullHome, ".claude", "skills"), { recursive: true, force: true });
    logged = [];

    runSkillifyCommand(["unpull"]);
    const out = logged.join("\n");
    expect(out).toMatch(/pruned \(orphan\)/);
    expect(out).toMatch(/manifest-pruned/);
  });

  // ── login gating ──────────────────────────────────────────────────────────
  // Unpull is a local FS-only operation in the default path; only --not-mine
  // needs a username to compare against. Don't force the user back through
  // `hivemind login` just to clean up disk state when their cred is gone.

  it("default unpull works when not logged in (no Deeplake call required)", async () => {
    loadConfigMock.mockReturnValue(null);
    runSkillifyCommand(["unpull", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).not.toMatch(/login/i);
    expect(logged.join("\n")).toMatch(/Result: 0 removed/);
  });

  it("--user X works when not logged in (filter is local, not a server query)", async () => {
    loadConfigMock.mockReturnValue(null);
    runSkillifyCommand(["unpull", "--user", "alice", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).not.toMatch(/login/i);
    expect(logged.join("\n")).toMatch(/users=alice/);
  });

  it("--not-mine still requires login (needs myUsername to exclude self)", async () => {
    loadConfigMock.mockReturnValue(null);
    runSkillifyCommand(["unpull", "--not-mine", "--dry-run"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).toMatch(/--not-mine requires a logged-in user/);
  });

  // ── filter+all conflict surfacing ─────────────────────────────────────────

  it("--all combined with --user surfaces a clear error message", async () => {
    runSkillifyCommand(["unpull", "--all", "--user", "alice"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).toMatch(/--all.*--user/);
  });

  it("--legacy-cleanup combined with --not-mine surfaces a clear error message", async () => {
    runSkillifyCommand(["unpull", "--legacy-cleanup", "--not-mine"]);
    await new Promise(r => setImmediate(r));
    expect(erred.join("\n")).toMatch(/--legacy-cleanup.*--not-mine/);
  });
});

// ── usage / unknown ───────────────────────────────────────────────────────

describe("usage", () => {
  it("--help prints usage", () => {
    runSkillifyCommand(["--help"]);
    expect(logged.join("\n")).toMatch(/Usage:/);
  });

  it("-h prints usage", () => {
    runSkillifyCommand(["-h"]);
    expect(logged.join("\n")).toMatch(/Usage:/);
  });

  it("unknown subcommand exits 1", () => {
    expectExit(1, () => runSkillifyCommand(["totally-unknown"]));
    expect(erred.join("\n")).toMatch(/Unknown skillify subcommand/);
  });

  it("--help mentions the mine-local subcommand", () => {
    runSkillifyCommand(["--help"]);
    expect(logged.join("\n")).toMatch(/mine-local/);
  });

  it("--help documents the correct --n default (matches DEFAULT_N = 8)", () => {
    runSkillifyCommand(["--help"]);
    // DEFAULT_N in src/commands/mine-local.ts is 8 — help text must agree.
    expect(logged.join("\n")).toMatch(/--n.*default: 8/);
    expect(logged.join("\n")).not.toMatch(/--n.*default: 3/);
  });
});

// ── mine-local subcommand wiring ──────────────────────────────────────────
//
// The mine-local orchestrator is exhaustively tested in
// mine-local-orchestrator.test.ts. Here we only assert the CLI surface:
// the subcommand dispatch forwards remaining args to runMineLocal and
// catches errors via process.exit(1).

describe("mine-local subcommand", () => {
  it("dispatches to runMineLocal with the remaining args", async () => {
    vi.doMock("../../src/commands/mine-local.js", () => ({
      runMineLocal: vi.fn().mockResolvedValue(undefined),
    }));
    vi.resetModules();
    const { runSkillifyCommand: cmd } = await import("../../src/commands/skillify.js");
    const mod = await import("../../src/commands/mine-local.js");
    cmd(["mine-local", "--dry-run", "--n", "3"]);
    await new Promise(r => setImmediate(r));
    expect((mod.runMineLocal as any)).toHaveBeenCalledWith(["--dry-run", "--n", "3"]);
  });

  it("rejected runMineLocal triggers process.exit(1) via .catch handler", async () => {
    // Swap the default `throw`-on-exit mock for this test only: the .catch
    // arrow in skillify.ts calls process.exit(1) WITHOUT a surrounding
    // try/catch, so a throwing mock surfaces as an unhandled rejection and
    // fails CI. Track the call without throwing.
    const exitCalls: number[] = [];
    exitSpy.mockImplementation(((code?: number) => { exitCalls.push(code ?? 0); }) as any);

    vi.doMock("../../src/commands/mine-local.js", () => ({
      runMineLocal: vi.fn().mockRejectedValue(new Error("synthetic mine-local fail")),
    }));
    vi.resetModules();
    const { runSkillifyCommand: cmd } = await import("../../src/commands/skillify.js");
    cmd(["mine-local"]);
    // Wait for the rejected promise to flush through the chain.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(exitCalls).toContain(1);
    expect(erred.join("\n")).toMatch(/synthetic mine-local fail/);
  });
});
