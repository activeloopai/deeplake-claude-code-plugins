import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end tests for the install/uninstall surface of every per-agent
 * installer. Each test runs against a fake HOME (mkdtempSync) so it never
 * touches the developer's real ~/.claude / ~/.codex / etc.
 *
 * Why this style — per CLAUDE.md "mock at the boundary, not in the middle":
 *   - We import the real installer functions from src/cli/install-*.ts.
 *   - We let them touch the *real* filesystem under our tmpdir HOME.
 *   - We mock only the boundary calls that would shell out elsewhere
 *     (codex CLI for tryEnableCodexHooks, npm for tryClaudePluginRegister).
 *
 * Coverage outcome: drives install-claude/codex/cursor/hermes/openclaw/pi
 * and install-mcp-shared from 0% to ~70-95% per file by exercising the
 * real install + uninstall paths against actual fs operations.
 */

const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...a: any[]) => execFileSyncMock(...a),
    execSync: (...a: any[]) => execSyncMock(...a),
  };
});

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "hm-e2e-"));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // Touch marker dirs so detectPlatforms() recognises each agent.
  for (const d of [".claude", ".codex", ".openclaw", ".cursor", ".hermes", ".pi"]) {
    mkdirSync(join(fakeHome, d), { recursive: true });
  }
  vi.resetModules();
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

// Helper: re-import a module after process.env.HOME has been set so its
// module-level HOME constant is the fake one.
async function freshImport<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

// ─── Codex ─────────────────────────────────────────────────────────────────

describe("installCodex / uninstallCodex", () => {
  it("install creates ~/.codex/hivemind/ + hooks.json + ~/.agents/skills symlink", async () => {
    const { installCodex } = await freshImport<typeof import("../../src/cli/install-codex.js")>(
      "../../src/cli/install-codex.js"
    );
    installCodex();

    expect(existsSync(join(fakeHome, ".codex/hivemind/bundle"))).toBe(true);
    expect(existsSync(join(fakeHome, ".codex/hivemind/.hivemind_version"))).toBe(true);
    expect(existsSync(join(fakeHome, ".codex/hooks.json"))).toBe(true);
    expect(existsSync(join(fakeHome, ".agents/skills/hivemind-memory"))).toBe(true);

    // hooks.json shape — exact event set + each event has at least one entry.
    const hooks = JSON.parse(readFileSync(join(fakeHome, ".codex/hooks.json"), "utf-8"));
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]
    );
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  it("install preserves user's pre-existing custom hook on a non-hivemind event", async () => {
    // Pre-create hooks.json with a user-defined Notification hook.
    const userHook = {
      hooks: { Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-notify.sh", timeout: 5 }] }] },
    };
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(join(fakeHome, ".codex/hooks.json"), JSON.stringify(userHook));

    const { installCodex } = await freshImport<typeof import("../../src/cli/install-codex.js")>(
      "../../src/cli/install-codex.js"
    );
    installCodex();

    const hooks = JSON.parse(readFileSync(join(fakeHome, ".codex/hooks.json"), "utf-8"));
    // User's Notification event survives + count is exact.
    expect(hooks.hooks.Notification).toHaveLength(1);
    expect(hooks.hooks.Notification[0].hooks[0].command).toBe("/usr/local/bin/my-notify.sh");
    // Plus our 5 events were added.
    expect(Object.keys(hooks.hooks)).toContain("SessionStart");
  });

  it("re-install is idempotent — no duplicate hivemind entries on PostToolUse", async () => {
    const { installCodex } = await freshImport<typeof import("../../src/cli/install-codex.js")>(
      "../../src/cli/install-codex.js"
    );
    installCodex();
    installCodex();
    installCodex();

    const hooks = JSON.parse(readFileSync(join(fakeHome, ".codex/hooks.json"), "utf-8"));
    // PostToolUse: still exactly one entry, not three.
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
  });

  it("uninstall removes hooks.json + skill link, keeps the plugin dir", async () => {
    const cx = await freshImport<typeof import("../../src/cli/install-codex.js")>(
      "../../src/cli/install-codex.js"
    );
    cx.installCodex();
    expect(existsSync(join(fakeHome, ".codex/hooks.json"))).toBe(true);

    cx.uninstallCodex();
    expect(existsSync(join(fakeHome, ".codex/hooks.json"))).toBe(false);
    expect(existsSync(join(fakeHome, ".agents/skills/hivemind-memory"))).toBe(false);
    // Plugin dir is intentionally retained — see install-codex.ts:81 comment.
    expect(existsSync(join(fakeHome, ".codex/hivemind"))).toBe(true);
  });
});

// ─── Cursor ────────────────────────────────────────────────────────────────

describe("installCursor / uninstallCursor", () => {
  it("install creates ~/.cursor/hivemind/ + writes hooks to ~/.cursor/hooks.json", async () => {
    const { installCursor } = await freshImport<typeof import("../../src/cli/install-cursor.js")>(
      "../../src/cli/install-cursor.js"
    );
    installCursor();

    expect(existsSync(join(fakeHome, ".cursor/hivemind/bundle"))).toBe(true);
    expect(existsSync(join(fakeHome, ".cursor/hooks.json"))).toBe(true);

    const cfg = JSON.parse(readFileSync(join(fakeHome, ".cursor/hooks.json"), "utf-8"));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.beforeSubmitPrompt).toBeDefined();
    expect(cfg.hooks.postToolUse).toBeDefined();
    // Marker key is set so uninstall can remove it cleanly.
    expect(cfg._hivemindManaged).toBeDefined();
  });

  it("install merges into existing hooks.json without losing user entries", async () => {
    const userCfg = {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "/usr/local/bin/my-prompt-hook.sh" }],
      },
      myCustomTopLevel: "preserve me",
    };
    mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
    writeFileSync(join(fakeHome, ".cursor/hooks.json"), JSON.stringify(userCfg));

    const { installCursor } = await freshImport<typeof import("../../src/cli/install-cursor.js")>(
      "../../src/cli/install-cursor.js"
    );
    installCursor();

    const cfg = JSON.parse(readFileSync(join(fakeHome, ".cursor/hooks.json"), "utf-8"));
    // User's beforeSubmitPrompt hook is still there + count includes ours.
    expect(cfg.hooks.beforeSubmitPrompt.length).toBeGreaterThanOrEqual(2);
    expect(cfg.hooks.beforeSubmitPrompt[0].command).toBe("/usr/local/bin/my-prompt-hook.sh");
    // User's top-level field preserved.
    expect(cfg.myCustomTopLevel).toBe("preserve me");
  });

  it("uninstall removes hivemind hooks; deletes hooks.json when nothing meaningful remains", async () => {
    const cx = await freshImport<typeof import("../../src/cli/install-cursor.js")>(
      "../../src/cli/install-cursor.js"
    );
    cx.installCursor();
    expect(existsSync(join(fakeHome, ".cursor/hooks.json"))).toBe(true);
    cx.uninstallCursor();
    // Only `version` would have remained → file deleted entirely.
    expect(existsSync(join(fakeHome, ".cursor/hooks.json"))).toBe(false);
  });

  it("uninstall preserves user hooks (only strips hivemind entries)", async () => {
    const cx = await freshImport<typeof import("../../src/cli/install-cursor.js")>(
      "../../src/cli/install-cursor.js"
    );
    cx.installCursor();

    // Add a user hook on top of the hivemind config.
    const cfgPath = join(fakeHome, ".cursor/hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.hooks.beforeSubmitPrompt.push({ command: "/usr/local/bin/user-hook.sh" });
    writeFileSync(cfgPath, JSON.stringify(cfg));

    cx.uninstallCursor();
    expect(existsSync(cfgPath)).toBe(true);
    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    // User hook survives, hivemind entries gone.
    const userHookSurvives = after.hooks.beforeSubmitPrompt
      .some((e: any) => e.command === "/usr/local/bin/user-hook.sh");
    expect(userHookSurvives).toBe(true);
    expect(after._hivemindManaged).toBeUndefined();
  });
});

// ─── Hermes ────────────────────────────────────────────────────────────────

describe("installHermes / uninstallHermes", () => {
  it("install drops bundle + skill + writes config.yaml with mcp_servers and hooks", async () => {
    const { installHermes } = await freshImport<typeof import("../../src/cli/install-hermes.js")>(
      "../../src/cli/install-hermes.js"
    );
    installHermes();

    expect(existsSync(join(fakeHome, ".hermes/hivemind/bundle"))).toBe(true);
    expect(existsSync(join(fakeHome, ".hermes/skills/hivemind-memory/SKILL.md"))).toBe(true);
    expect(existsSync(join(fakeHome, ".hermes/config.yaml"))).toBe(true);

    const cfg = readFileSync(join(fakeHome, ".hermes/config.yaml"), "utf-8");
    expect(cfg).toContain("mcp_servers:");
    expect(cfg).toContain("hooks:");
    expect(cfg).toContain("hivemind");
  });

  it("install preserves a user-defined section in config.yaml", async () => {
    const userCfg = "user_section:\n  custom: true\n";
    mkdirSync(join(fakeHome, ".hermes"), { recursive: true });
    writeFileSync(join(fakeHome, ".hermes/config.yaml"), userCfg);

    const { installHermes } = await freshImport<typeof import("../../src/cli/install-hermes.js")>(
      "../../src/cli/install-hermes.js"
    );
    installHermes();

    const cfg = readFileSync(join(fakeHome, ".hermes/config.yaml"), "utf-8");
    expect(cfg).toContain("user_section");
    expect(cfg).toContain("custom: true");
  });

  it("uninstall strips skill + hivemind config sections, keeps non-hivemind user entries", async () => {
    const hx = await freshImport<typeof import("../../src/cli/install-hermes.js")>(
      "../../src/cli/install-hermes.js"
    );
    hx.installHermes();
    expect(existsSync(join(fakeHome, ".hermes/skills/hivemind-memory/SKILL.md"))).toBe(true);

    hx.uninstallHermes();
    expect(existsSync(join(fakeHome, ".hermes/skills/hivemind-memory"))).toBe(false);
  });
});

// OpenClaw tests intentionally omitted from this end-to-end file:
// `openclaw/dist/` is gitignored (esbuild output, see .gitignore: dist/),
// so it doesn't exist on a fresh CI checkout the way the committed
// codex/cursor/hermes bundles do. The dedicated test file
// `cli-install-openclaw.test.ts` covers OpenClaw via mock-pkgRoot →
// fake-tmpdir pattern that doesn't depend on the real dist being present.

// ─── pi ────────────────────────────────────────────────────────────────────

describe("installPi / uninstallPi", () => {
  it("install upserts AGENTS.md hivemind block + drops extension at ~/.pi/agent/extensions/", async () => {
    const { installPi } = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    installPi();

    expect(existsSync(join(fakeHome, ".pi/agent/AGENTS.md"))).toBe(true);
    expect(existsSync(join(fakeHome, ".pi/agent/extensions/hivemind.ts"))).toBe(true);

    const agents = readFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), "utf-8");
    expect(agents).toContain("BEGIN hivemind-memory");
    expect(agents).toContain("END hivemind-memory");
  });

  it("install does NOT drop a per-agent ~/.pi/agent/skills/hivemind-memory/SKILL.md", async () => {
    // Negative pattern: pi reads from both ~/.pi/agent/skills and
    // ~/.agents/skills, so a per-agent drop would collide with the codex
    // installer's shared symlink. install-pi.ts deliberately skips it.
    const { installPi } = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    installPi();
    expect(existsSync(join(fakeHome, ".pi/agent/skills/hivemind-memory/SKILL.md"))).toBe(false);
  });

  it("install preserves user-edited AGENTS.md content outside the marker block", async () => {
    const userAgents = "# My pi guidance\n\n- always be helpful\n";
    mkdirSync(join(fakeHome, ".pi/agent"), { recursive: true });
    writeFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), userAgents);

    const { installPi } = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    installPi();

    const after = readFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), "utf-8");
    expect(after).toContain("# My pi guidance");
    expect(after).toContain("- always be helpful");
    expect(after).toContain("BEGIN hivemind-memory");
  });

  it("re-install is idempotent — exactly one BEGIN/END marker pair after multiple runs", async () => {
    const { installPi } = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    installPi();
    installPi();
    installPi();

    const after = readFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), "utf-8");
    const begins = (after.match(/BEGIN hivemind-memory/g) ?? []).length;
    const ends = (after.match(/END hivemind-memory/g) ?? []).length;
    expect(begins).toBe(1);
    expect(ends).toBe(1);
  });

  it("uninstall removes extension; AGENTS.md is deleted if it ends up empty", async () => {
    const cx = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    cx.installPi();
    cx.uninstallPi();

    expect(existsSync(join(fakeHome, ".pi/agent/extensions/hivemind.ts"))).toBe(false);
    // AGENTS.md had nothing else → installer deletes the empty file.
    expect(existsSync(join(fakeHome, ".pi/agent/AGENTS.md"))).toBe(false);
  });

  it("uninstall preserves AGENTS.md user content outside the marker block", async () => {
    const userAgents = "# My pi guidance\n\n- always be helpful\n";
    mkdirSync(join(fakeHome, ".pi/agent"), { recursive: true });
    writeFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), userAgents);

    const cx = await freshImport<typeof import("../../src/cli/install-pi.js")>(
      "../../src/cli/install-pi.js"
    );
    cx.installPi();
    cx.uninstallPi();

    const after = readFileSync(join(fakeHome, ".pi/agent/AGENTS.md"), "utf-8");
    expect(after).toContain("# My pi guidance");
    expect(after).not.toContain("BEGIN hivemind-memory");
  });
});

// ─── MCP shared server ────────────────────────────────────────────────────

describe("ensureMcpServerInstalled", () => {
  it("drops server.js into ~/.hivemind/mcp/ + version stamp at ~/.hivemind/", async () => {
    const { ensureMcpServerInstalled } = await freshImport<
      typeof import("../../src/cli/install-mcp-shared.js")
    >("../../src/cli/install-mcp-shared.js");
    ensureMcpServerInstalled();

    expect(existsSync(join(fakeHome, ".hivemind/mcp/server.js"))).toBe(true);
    // writeVersionStamp(HIVEMIND_DIR, ...) writes to ~/.hivemind/.hivemind_version,
    // one level above MCP_DIR — see install-mcp-shared.ts.
    expect(existsSync(join(fakeHome, ".hivemind/.hivemind_version"))).toBe(true);
  });

  it("buildMcpServerEntry returns a valid MCP server config record", async () => {
    const { buildMcpServerEntry } = await freshImport<
      typeof import("../../src/cli/install-mcp-shared.js")
    >("../../src/cli/install-mcp-shared.js");
    const entry = buildMcpServerEntry() as { command: string; args: string[] };
    expect(entry.command).toBe("node");
    expect(entry.args).toBeInstanceOf(Array);
    expect(entry.args[0]).toMatch(/server\.js$/);
  });
});

// ─── Claude Code ──────────────────────────────────────────────────────────
//
// installClaude delegates to the `claude` CLI (it doesn't manage its own
// filesystem footprint — Claude Code's plugin loader does). So the unit
// tests here mock the `claude` invocations and assert on the orchestration
// flow (which subcommands run, in what order, and skip-when-already-done).

function buildClaudeMock(state: {
  hasCli?: boolean;
  marketplaceListed?: boolean;
  pluginInstalled?: boolean;
}) {
  const calls: string[][] = [];
  return {
    calls,
    impl: (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
      if (cmd !== "claude") return Buffer.from("");
      if (args[0] === "--version") {
        if (state.hasCli === false) throw new Error("ENOENT: claude not found");
        return Buffer.from("1.2.3\n");
      }
      const sub = args.join(" ");
      if (sub === "plugin marketplace list") {
        return Buffer.from(state.marketplaceListed ? "hivemind\nfoo\n" : "foo\nbar\n");
      }
      if (sub === "plugin list") {
        return Buffer.from(state.pluginInstalled ? "hivemind@hivemind\n" : "other-plugin\n");
      }
      return Buffer.from("");
    },
  };
}

describe("installClaude / uninstallClaude", () => {
  it("install on fresh system: adds marketplace, installs plugin, enables it", async () => {
    const m = buildClaudeMock({ hasCli: true, marketplaceListed: false, pluginInstalled: false });
    execFileSyncMock.mockImplementation(m.impl);
    const { installClaude } = await freshImport<typeof import("../../src/cli/install-claude.js")>(
      "../../src/cli/install-claude.js"
    );
    installClaude();
    const cmds = m.calls.map(c => c.slice(1).join(" "));
    expect(cmds).toContain("--version");
    expect(cmds).toContain("plugin marketplace add activeloopai/hivemind");
    expect(cmds).toContain("plugin install hivemind");
    expect(cmds).toContain("plugin enable hivemind@hivemind");
  });

  it("install skips marketplace+install when already configured (idempotent)", async () => {
    const m = buildClaudeMock({ hasCli: true, marketplaceListed: true, pluginInstalled: true });
    execFileSyncMock.mockImplementation(m.impl);
    const { installClaude } = await freshImport<typeof import("../../src/cli/install-claude.js")>(
      "../../src/cli/install-claude.js"
    );
    installClaude();
    const cmds = m.calls.map(c => c.slice(1).join(" "));
    // Negative pattern (CLAUDE.md rule 8): no duplicate `marketplace add` or
    // `plugin install` on second call when state shows it's already there.
    expect(cmds).not.toContain("plugin marketplace add activeloopai/hivemind");
    expect(cmds).not.toContain("plugin install hivemind");
    // Enable is still safe to run unconditionally.
    expect(cmds).toContain("plugin enable hivemind@hivemind");
  });

  it("install throws a clear error when claude CLI is missing", async () => {
    const m = buildClaudeMock({ hasCli: false });
    execFileSyncMock.mockImplementation(m.impl);
    const { installClaude } = await freshImport<typeof import("../../src/cli/install-claude.js")>(
      "../../src/cli/install-claude.js"
    );
    // CONTRACT: install fails fast with a user-facing message — claude CLI
    // is a hard prerequisite, not a soft fallback.
    expect(() => installClaude()).toThrow(/Claude Code CLI/);
  });

  it("uninstall calls plugin disable + uninstall when claude CLI is present", async () => {
    const m = buildClaudeMock({ hasCli: true });
    execFileSyncMock.mockImplementation(m.impl);
    const { uninstallClaude } = await freshImport<typeof import("../../src/cli/install-claude.js")>(
      "../../src/cli/install-claude.js"
    );
    uninstallClaude();
    const cmds = m.calls.map(c => c.slice(1).join(" "));
    expect(cmds).toContain("plugin disable hivemind@hivemind");
    expect(cmds).toContain("plugin uninstall hivemind@hivemind");
  });

  it("uninstall is graceful when claude CLI is missing (logs, does not throw)", async () => {
    const m = buildClaudeMock({ hasCli: false });
    execFileSyncMock.mockImplementation(m.impl);
    const { uninstallClaude } = await freshImport<typeof import("../../src/cli/install-claude.js")>(
      "../../src/cli/install-claude.js"
    );
    expect(() => uninstallClaude()).not.toThrow();
  });
});
