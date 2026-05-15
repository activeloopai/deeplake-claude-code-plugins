import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnWikiWorker, bundleDirFromImportMeta, findClaudeBin } from "../../src/hooks/spawn-wiki-worker.js";
import { spawnCodexWikiWorker } from "../../src/hooks/codex/spawn-wiki-worker.js";
import { spawnCursorWikiWorker } from "../../src/hooks/cursor/spawn-wiki-worker.js";
import { spawnHermesWikiWorker } from "../../src/hooks/hermes/spawn-wiki-worker.js";
import type { Config } from "../../src/config.js";

/**
 * Per-agent guard for the spawn-wiki-worker helpers.
 *
 * Each spawn helper:
 *   1. Reads the installed plugin version via getInstalledVersion(bundleDir, manifestDir)
 *      — the manifest dir differs per agent (".claude-plugin" / ".codex-plugin").
 *   2. Writes a config.json the detached worker reads at startup.
 *   3. Spawns `nohup node <worker.js> <config.json>`.
 *
 * The thing the e2e on test_plugin couldn't directly observe is whether
 * pluginVersion actually lands in config.json for every agent. A regression
 * here would silently ship "" through to the worker → "" in plugin_version
 * on every summary row, with the e2e only catching it if we check that
 * specific column for that specific agent's worker output.
 *
 * Tests mock the `child_process.spawn` boundary so no actual subprocess
 * launches; the config.json on disk is the assertion target.
 */

// Capture spawn calls so we can verify what the agent would have spawned
// without actually running it.
const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      // Match the surface the production code touches: a child object
      // with `.unref()`. No stdio, no event emission.
      return { unref: () => {} } as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

// Stub HOME so the helpers don't write into the developer's real ~/.claude.
let originalHome: string | undefined;
let fakeHome: string;
let scratchRoot: string;

beforeEach(() => {
  spawnCalls.length = 0;
  scratchRoot = mkdtempSync(join(tmpdir(), "hm-spawn-test-"));
  fakeHome = join(scratchRoot, "home");
  mkdirSync(fakeHome, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(scratchRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface PlantedBundle {
  bundleDir: string;
  pluginVersion: string;
}

/**
 * Place a bundle dir under a tmp PLUGIN_DIR with the right manifest layout
 * so getInstalledVersion(bundleDir, manifestDir) resolves to the planted
 * version via the first lookup branch (manifest plugin.json).
 */
function plantBundle(manifestDir: string, version = "9.9.9"): PlantedBundle {
  const pluginDir = join(scratchRoot, `plugin-${Math.random().toString(36).slice(2)}`);
  const bundleDir = join(pluginDir, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(pluginDir, manifestDir), { recursive: true });
  writeFileSync(join(pluginDir, manifestDir, "plugin.json"), JSON.stringify({ version }));
  return { bundleDir, pluginVersion: version };
}

function fakeConfig(): Config {
  return {
    token: "tok",
    orgId: "org-1",
    orgName: "acme",
    userName: "alice",
    workspaceId: "default",
    apiUrl: "https://api.example",
    tableName: "memory",
    sessionsTableName: "sessions",
    skillsTableName: "skills",
    memoryPath: "/tmp/fake-memory",
  };
}

function readSpawnedConfig(): Record<string, unknown> {
  expect(spawnCalls).toHaveLength(1);
  const [, , configPath] = spawnCalls[0].args;
  return JSON.parse(readFileSync(configPath as string, "utf-8"));
}

describe("spawnWikiWorker (claude-code) — plugin_version threading", () => {
  it("writes the resolved plugin version into the spawn config", () => {
    const { bundleDir, pluginVersion } = plantBundle(".claude-plugin", "1.2.3");
    spawnWikiWorker({
      config: fakeConfig(),
      sessionId: "s-cc",
      cwd: "/work/repo",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    expect(cfg.pluginVersion).toBe(pluginVersion);
    // Project name is derived from cwd basename.
    expect(cfg.project).toBe("repo");
    // Session id and table names propagate.
    expect(cfg.sessionId).toBe("s-cc");
    expect(cfg.memoryTable).toBe("memory");
    expect(cfg.sessionsTable).toBe("sessions");
  });

  it("falls back to '' when the bundle has no resolvable manifest (so the column gets DEFAULT '')", () => {
    // Empty bundle dir under scratchRoot — no .claude-plugin, no .hivemind_version,
    // and no parent package.json with a hivemind name within the walk budget.
    const bundleDir = join(scratchRoot, "orphan", "bundle");
    mkdirSync(bundleDir, { recursive: true });
    spawnWikiWorker({
      config: fakeConfig(),
      sessionId: "s-orphan",
      cwd: "/work/x",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    expect(cfg.pluginVersion).toBe("");
  });

  it("spawns the worker with nohup + the written config path", () => {
    const { bundleDir } = plantBundle(".claude-plugin");
    spawnWikiWorker({
      config: fakeConfig(),
      sessionId: "s-spawn",
      cwd: "/work/x",
      bundleDir,
      reason: "TestSpawn",
    });
    expect(spawnCalls).toHaveLength(1);
    const [{ cmd, args }] = spawnCalls;
    expect(cmd).toBe("nohup");
    expect(args[0]).toBe("node");
    expect(args[1]).toBe(join(bundleDir, "wiki-worker.js"));
    expect((args[2] as string).endsWith("config.json")).toBe(true);
  });
});

describe("spawnCodexWikiWorker — uses .codex-plugin manifest", () => {
  it("resolves plugin version from .codex-plugin and threads it through", () => {
    const { bundleDir, pluginVersion } = plantBundle(".codex-plugin", "4.5.6");
    spawnCodexWikiWorker({
      config: fakeConfig(),
      sessionId: "s-codex",
      cwd: "/work/proj",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    expect(cfg.pluginVersion).toBe(pluginVersion);
    // Codex config carries `codexBin` instead of claudeBin — sanity check the
    // surrounding shape didn't drift when threading pluginVersion.
    expect(typeof cfg.codexBin).toBe("string");
  });

  it("does NOT resolve from .claude-plugin (regression guard for manifest mix-up)", () => {
    // Plant .claude-plugin with a wrong version; codex must ignore it.
    const { bundleDir } = plantBundle(".claude-plugin", "0.0.1");
    spawnCodexWikiWorker({
      config: fakeConfig(),
      sessionId: "s-codex-wrong",
      cwd: "/work/proj",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    // .codex-plugin missing → falls through to walk-up; the planted
    // claude-plugin manifest must NOT be picked up.
    expect(cfg.pluginVersion).not.toBe("0.0.1");
  });
});

describe("spawnCursorWikiWorker — plugin_version threading", () => {
  it("writes pluginVersion + cursor-specific fields into the spawn config", () => {
    const { bundleDir, pluginVersion } = plantBundle(".claude-plugin", "7.8.9");
    spawnCursorWikiWorker({
      config: fakeConfig(),
      sessionId: "s-cur",
      cwd: "/work/x",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    expect(cfg.pluginVersion).toBe(pluginVersion);
    expect(typeof cfg.cursorBin).toBe("string");
    expect(typeof cfg.cursorModel).toBe("string");
  });
});

describe("spawnHermesWikiWorker — plugin_version threading", () => {
  it("writes pluginVersion + hermes-specific fields into the spawn config", () => {
    const { bundleDir, pluginVersion } = plantBundle(".claude-plugin", "3.3.3");
    spawnHermesWikiWorker({
      config: fakeConfig(),
      sessionId: "s-her",
      cwd: "/work/x",
      bundleDir,
      reason: "TestSpawn",
    });
    const cfg = readSpawnedConfig();
    expect(cfg.pluginVersion).toBe(pluginVersion);
    expect(typeof cfg.hermesBin).toBe("string");
    expect(typeof cfg.hermesProvider).toBe("string");
    expect(typeof cfg.hermesModel).toBe("string");
  });
});

describe("bundleDirFromImportMeta", () => {
  it("returns the directory containing the entry module", () => {
    // Build a file:// URL pointing at a fake bundle file and assert the
    // result is the parent dir of that file. Mirrors how every hook
    // bootstrap calls this helper.
    const fakeUrl = "file:///path/to/some/bundle/capture.js";
    expect(bundleDirFromImportMeta(fakeUrl)).toBe("/path/to/some/bundle");
  });
});

describe("findClaudeBin", () => {
  it("returns a non-empty string (resolved bin path or fallback)", () => {
    // findClaudeBin shells out to `which claude`; in CI / dev that may or
    // may not exist. Either way, the function must return a usable string
    // (the resolved path on success, the home-relative fallback on
    // failure). Asserting non-empty exercises both branches across
    // environments.
    const bin = findClaudeBin();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });
});
