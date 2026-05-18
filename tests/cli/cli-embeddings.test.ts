import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disableEmbeddings,
  enableEmbeddings,
  findHivemindInstalls,
  installEmbeddings,
  isSharedDepsInstalled,
  killEmbedDaemon,
  linkStateFor,
  SHARED_DAEMON_PATH,
  SHARED_NODE_MODULES,
  TRANSFORMERS_PKG,
  uninstallEmbeddings,
  _linkAgentForTesting,
} from "../../src/cli/embeddings.js";
import { _resetUserConfigForTesting, _setConfigPathForTesting, getEmbeddingsEnabled } from "../../src/user-config.js";

/**
 * Tests for the shared-deps embeddings installer's pure helpers. The
 * filesystem IS the boundary here (no network) so we drive these against
 * a real tmp dir rather than mocking node:fs — same approach as the
 * existing install-helpers / cli-install-* test files.
 */

let tmpHome: string;

function mkDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function fakeBundleAt(dir: string): void {
  mkDir(join(dir, "bundle"));
  writeFileSync(join(dir, "bundle", "session-start.js"), "//");
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "hivemind-embeddings-test-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── findHivemindInstalls ──────────────────────────────────────────────────

describe("findHivemindInstalls", () => {
  it("returns empty when nothing is installed", () => {
    expect(findHivemindInstalls(tmpHome)).toEqual([]);
  });

  it("detects codex/cursor/hermes when each has a bundle/ subdir", () => {
    fakeBundleAt(join(tmpHome, ".codex", "hivemind"));
    fakeBundleAt(join(tmpHome, ".cursor", "hivemind"));
    fakeBundleAt(join(tmpHome, ".hermes", "hivemind"));
    const installs = findHivemindInstalls(tmpHome);
    expect(installs.map(i => i.id).sort()).toEqual(["codex", "cursor", "hermes"]);
    for (const i of installs) {
      expect(i.pluginDir).toContain(tmpHome);
      expect(i.pluginDir).toMatch(/hivemind$/);
    }
  });

  it("ignores agent dirs that exist but lack a bundle/ subdir (incomplete install)", () => {
    mkDir(join(tmpHome, ".codex", "hivemind")); // exists but no bundle/
    expect(findHivemindInstalls(tmpHome)).toEqual([]);
  });

  it("detects every versioned Claude Code plugin in cache/hivemind/hivemind/", () => {
    const cache = join(tmpHome, ".claude", "plugins", "cache", "hivemind", "hivemind");
    fakeBundleAt(join(cache, "0.7.0"));
    fakeBundleAt(join(cache, "0.7.1"));
    const installs = findHivemindInstalls(tmpHome);
    expect(installs.map(i => i.id).sort()).toEqual(["claude (0.7.0)", "claude (0.7.1)"]);
  });

  it("supports the alternate <version>/claude-code/bundle layout", () => {
    const cache = join(tmpHome, ".claude", "plugins", "cache", "hivemind", "hivemind");
    fakeBundleAt(join(cache, "0.7.0", "claude-code"));
    const installs = findHivemindInstalls(tmpHome);
    expect(installs).toHaveLength(1);
    expect(installs[0].id).toBe("claude (0.7.0)");
  });

  it("skips entries in cache/hivemind/hivemind/ that aren't directories with bundles", () => {
    const cache = join(tmpHome, ".claude", "plugins", "cache", "hivemind", "hivemind");
    mkDir(cache);
    writeFileSync(join(cache, "stray-file"), ""); // not a dir
    mkDir(join(cache, "0.7.0")); // dir, but no bundle
    expect(findHivemindInstalls(tmpHome)).toEqual([]);
  });
});

// ── isSharedDepsInstalled ─────────────────────────────────────────────────

describe("isSharedDepsInstalled", () => {
  it("false when the transformers dir does not exist under <shared>/node_modules/", () => {
    const sharedNm = join(tmpHome, "embed-deps", "node_modules");
    expect(isSharedDepsInstalled(sharedNm)).toBe(false);
  });

  it("true when @huggingface/transformers is present under the given node_modules", () => {
    const sharedNm = join(tmpHome, "embed-deps", "node_modules");
    mkDir(join(sharedNm, TRANSFORMERS_PKG));
    expect(isSharedDepsInstalled(sharedNm)).toBe(true);
  });
});

// ── SHARED_DAEMON_PATH ────────────────────────────────────────────────────

describe("SHARED_DAEMON_PATH", () => {
  it("points at embed-daemon.js inside the shared-deps dir (canonical location agents use)", () => {
    expect(SHARED_DAEMON_PATH.endsWith("/embed-deps/embed-daemon.js")).toBe(true);
  });
});

// ── linkStateFor ──────────────────────────────────────────────────────────

describe("linkStateFor", () => {
  it("returns no-node-modules when the install dir has no node_modules at all", () => {
    fakeBundleAt(join(tmpHome, ".codex", "hivemind"));
    const state = linkStateFor({ id: "codex", pluginDir: join(tmpHome, ".codex", "hivemind") });
    expect(state.kind).toBe("no-node-modules");
  });

  it("returns linked-to-shared when node_modules is a symlink to the canonical shared dir", () => {
    const sharedNm = join(tmpHome, "shared-nm");
    mkDir(sharedNm);
    const pluginDir = join(tmpHome, ".codex", "hivemind");
    fakeBundleAt(pluginDir);
    symlinkSync(sharedNm, join(pluginDir, "node_modules"));
    const state = linkStateFor({ id: "codex", pluginDir }, sharedNm);
    expect(state.kind).toBe("linked-to-shared");
  });

  it("returns linked-elsewhere when node_modules is a symlink to a different target", () => {
    const otherDir = join(tmpHome, "other");
    mkDir(otherDir);
    const sharedNm = join(tmpHome, "shared-nm");
    const pluginDir = join(tmpHome, ".codex", "hivemind");
    fakeBundleAt(pluginDir);
    symlinkSync(otherDir, join(pluginDir, "node_modules"));
    const state = linkStateFor({ id: "codex", pluginDir }, sharedNm);
    expect(state.kind).toBe("linked-elsewhere");
    if (state.kind === "linked-elsewhere") expect(state.target).toBe(otherDir);
  });

  it("returns owns-own-node-modules when node_modules is a real directory", () => {
    const pluginDir = join(tmpHome, ".codex", "hivemind");
    fakeBundleAt(pluginDir);
    mkDir(join(pluginDir, "node_modules"));
    const state = linkStateFor({ id: "codex", pluginDir });
    expect(state.kind).toBe("owns-own-node-modules");
  });
});

// ── lightweight enable / disable: config-only, no fs install ──────────────

describe("enableEmbeddings / disableEmbeddings — config flag mutation", () => {
  let cfgPath: string;

  beforeEach(() => {
    cfgPath = join(tmpHome, "config.json");
    _setConfigPathForTesting(() => cfgPath);
  });

  afterEach(() => {
    _resetUserConfigForTesting();
  });

  it("enableEmbeddings writes embeddings.enabled:true to ~/.deeplake/config.json", () => {
    enableEmbeddings();
    expect(existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(readFileSync(cfgPath, "utf-8"))).toEqual({ embeddings: { enabled: true } });
    expect(getEmbeddingsEnabled()).toBe(true);
  });

  it("disableEmbeddings writes embeddings.enabled:false to ~/.deeplake/config.json", () => {
    enableEmbeddings();
    disableEmbeddings();
    expect(JSON.parse(readFileSync(cfgPath, "utf-8"))).toEqual({ embeddings: { enabled: false } });
    expect(getEmbeddingsEnabled()).toBe(false);
  });

  it("disableEmbeddings is idempotent (no error when no daemon and no config)", () => {
    expect(() => disableEmbeddings()).not.toThrow();
    expect(getEmbeddingsEnabled()).toBe(false);
  });

  it("enableEmbeddings overrides a prior disableEmbeddings (last write wins)", () => {
    disableEmbeddings();
    enableEmbeddings();
    expect(getEmbeddingsEnabled()).toBe(true);
  });
});

// ── killEmbedDaemon: tolerant of every combination of missing files ───────

describe("killEmbedDaemon", () => {
  it("returns silently when there is no pidfile or socket (fresh machine)", () => {
    // SOCKET_DIR defaults to /tmp/.hivemind-embed-<random>/ in production — we
    // can't redirect that without monkey-patching. But the function only ever
    // reads + best-effort-deletes, so calling it when nothing exists is a
    // no-op by design.
    expect(() => killEmbedDaemon()).not.toThrow();
  });
});

// ── uninstall: writes config:false even when shared deps absent ───────────

describe("killEmbedDaemon — verifies socket before SIGTERM (#2)", () => {
  // Regression for CodeRabbit #2: previously killEmbedDaemon read the PID
  // from the pidfile and blindly SIGTERMed it. If the daemon had crashed
  // and the OS recycled that PID to an unrelated user process,
  // `hivemind embeddings disable` would silently kill that process. The
  // fix gates the SIGTERM on `_isDaemonAliveOnSocket` — if the UDS path
  // doesn't accept a connect within a short timeout, the daemon is dead
  // and the PID in the file is stale, so we only clean up sock+pid.
  it("skips SIGTERM when the socket is dead (stale pidfile path)", async () => {
    const { killEmbedDaemon: kill, _isDaemonAliveOnSocket } = await import(
      "../../src/cli/embeddings.js"
    );

    // Test isolation: use a per-test tmp dir for the sock/pid files
    // instead of the real /tmp/hivemind-embed-<uid>.* paths. Without
    // this, the test would clobber any real daemon's socket/pidfile
    // for the same uid on the dev machine or CI worker.
    const { pidPathFor, socketPathFor } = await import("../../src/embeddings/protocol.js");
    const sockDir = mkdtempSync(join(tmpdir(), "kill-test-"));
    const uid = String(process.getuid?.() ?? 0);
    const pidPath = pidPathFor(uid, sockDir);
    const sockPath = socketPathFor(uid, sockDir);

    try {
      // Write the *current process's* pid into the file. If the broken
      // code ran, our test runner would receive SIGTERM and die. With
      // the fix, the socket-alive probe sees no socket bound and
      // killEmbedDaemon should skip the SIGTERM step entirely.
      writeFileSync(pidPath, String(process.pid));
      // sockPath doesn't exist (we never wrote it), so the probe sees no
      // socket binding.

      // Probe asserts the socket isn't alive.
      expect(_isDaemonAliveOnSocket(sockPath, 100)).toBe(false);

      // The call must NOT crash the test runner (i.e. we must NOT
      // receive SIGTERM). Passing the per-test sockDir keeps the call
      // bound to our tmp paths.
      kill(sockDir);

      // Sock+pid file cleanup still runs against the tmp paths.
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(sockPath)).toBe(false);
    } finally {
      rmSync(sockDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("linkAgent — preserves real node_modules directory (#1)", () => {
  // Regression for CodeRabbit #1: previously `linkAgent` went straight
  // through `symlinkForce` → `unlinkSync` on whatever existed at
  // `<plugin>/node_modules`. If the path was a real directory (a
  // marketplace plugin shipping its own deps, or a dev `npm install`),
  // `unlinkSync` threw EISDIR and aborted `hivemind embeddings install`
  // partway through, leaving some agents linked and others not.
  it("skips linking when a real node_modules directory already exists at the link path", () => {
    const pluginDir = join(tmpHome, ".fake-agent", "hivemind");
    mkDir(join(pluginDir, "bundle"));
    // Existing real `node_modules/` dir with content (simulates a
    // plugin that already shipped deps).
    const realNm = join(pluginDir, "node_modules");
    mkDir(realNm);
    writeFileSync(join(realNm, "marker.txt"), "preserved");

    // Must NOT throw.
    expect(() =>
      _linkAgentForTesting({ id: "fake-agent", pluginDir })
    ).not.toThrow();

    // Real dir is intact, marker file untouched.
    expect(existsSync(realNm)).toBe(true);
    expect(lstatSync(realNm).isDirectory()).toBe(true);
    expect(lstatSync(realNm).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(realNm, "marker.txt"), "utf-8")).toBe("preserved");
  });

  it("still replaces a stale symlink at the link path (normal install path unaffected)", () => {
    const pluginDir = join(tmpHome, ".fake-agent2", "hivemind");
    mkDir(join(pluginDir, "bundle"));
    // Simulate a shared-deps target so symlinkForce has somewhere to point.
    const fakeShared = join(tmpHome, ".hivemind", "embed-deps", "node_modules");
    mkDir(fakeShared);
    // Pre-existing symlink to a stale location.
    const stale = join(tmpHome, "stale");
    mkDir(stale);
    symlinkSync(stale, join(pluginDir, "node_modules"));

    // Without HOME override the real SHARED_NODE_MODULES is used, so we
    // can only assert "no throw" + "still a symlink after". The exact
    // target depends on the runtime HOME, but the call must succeed.
    expect(() =>
      _linkAgentForTesting({ id: "fake-agent2", pluginDir })
    ).not.toThrow();
    expect(lstatSync(join(pluginDir, "node_modules")).isSymbolicLink()).toBe(true);
  });
});

describe("uninstallEmbeddings — config flag side effect", () => {
  let cfgPath: string;

  beforeEach(() => {
    cfgPath = join(tmpHome, "config.json");
    _setConfigPathForTesting(() => cfgPath);
  });

  afterEach(() => {
    _resetUserConfigForTesting();
  });

  it("flips embeddings.enabled:false even when there are no agent installs and no shared deps", () => {
    // No installs detected, no shared deps dir — uninstall still flips the flag.
    enableEmbeddings();
    uninstallEmbeddings();
    expect(getEmbeddingsEnabled()).toBe(false);
  });
});
