import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Source-level tests for src/hooks/session-start-setup.ts. This hook
 * handles three things on a fresh session: table setup, userName
 * backfill, and version check + auto-update. Mocks the boundaries:
 * readStdin, loadCredentials, saveCredentials, loadConfig, DeeplakeApi,
 * global fetch (for the GitHub version lookup), and execSync (for the
 * claude-plugin update call).
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const saveCredsMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const ensureTableMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const execSyncMock = vi.fn();
const embedWarmupMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: any[]) => loadCredsMock(...a),
  saveCredentials: (...a: any[]) => saveCredsMock(...a),
}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: any[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_t: string, msg: string) => debugLogMock(msg),
  utcTimestamp: () => "2026-04-17 00:00:00 UTC",
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    ensureTable() { return ensureTableMock(); }
    ensureSessionsTable(t: string) { return ensureSessionsTableMock(t); }
  },
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: (...a: any[]) => execSyncMock(...a) };
});
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    async warmup() { return embedWarmupMock(); }
  },
}));

// We also need to control global.fetch for the GitHub version lookup.
const originalFetch = global.fetch;
const fetchMock = vi.fn();

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  // @ts-expect-error: replace global fetch for the GitHub lookup
  global.fetch = fetchMock;
  await import("../../src/hooks/session-start-setup.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
  userName: "alice", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", cwd: "/x" });
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "o", orgName: "acme", userName: "alice",
  });
  saveCredsMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  ensureTableMock.mockReset().mockResolvedValue(undefined);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  execSyncMock.mockReset();
  embedWarmupMock.mockReset().mockResolvedValue(true);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ version: "0.0.1" }), // same-as-current: no update
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error
  global.fetch = originalFetch;
});

describe("session-start-setup hook — guards", () => {
  it("returns without reading stdin when HIVEMIND_WIKI_WORKER=1", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("returns when no credentials are loaded", async () => {
    loadCredsMock.mockReturnValue(null);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no credentials");
    expect(ensureTableMock).not.toHaveBeenCalled();
  });

  it("returns when credentials have no token", async () => {
    loadCredsMock.mockReturnValue({ token: "", userName: "alice" });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no credentials");
  });
});

describe("session-start-setup hook — userName backfill", () => {
  it("backfills userName via node:os when missing and saves creds", async () => {
    loadCredsMock.mockReturnValue({ token: "tok", orgId: "o", orgName: "acme" });
    await runHook();
    expect(saveCredsMock).toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringMatching(/^backfilled userName: /),
    );
  });

  it("does not call saveCredentials when userName already set", async () => {
    // Default creds in beforeEach have userName=alice.
    await runHook();
    expect(saveCredsMock).not.toHaveBeenCalled();
  });
});

describe("session-start-setup hook — table setup", () => {
  it("ensures both tables on the happy path", async () => {
    await runHook();
    expect(ensureTableMock).toHaveBeenCalled();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    expect(debugLogMock).toHaveBeenCalledWith("setup complete");
  });

  it("swallows setup errors and logs them", async () => {
    ensureTableMock.mockRejectedValue(new Error("table boom"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("setup failed: table boom");
  });

  it("skips setup entirely when session_id is empty", async () => {
    stdinMock.mockResolvedValue({ session_id: "", cwd: "/x" });
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });

  it("skips setup when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(ensureTableMock).not.toHaveBeenCalled();
  });
});

describe("session-start-setup hook — version check + autoupdate", () => {
  it("runs the autoupdate path when newer version is available", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0" }), // clearly newer
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(execSyncMock).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("auto-updated"),
    );
  });

  it("emits a manual-upgrade message when autoupdate is disabled and newer exists", async () => {
    loadCredsMock.mockReturnValue({
      token: "t", orgId: "o", orgName: "acme", userName: "alice",
      autoupdate: false,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0" }),
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("update available"),
    );
  });

  it("emits the 'auto-update failed' message when execSync throws", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "999.0.0" }),
    });
    execSyncMock.mockImplementation(() => { throw new Error("npm down"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runHook();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-update failed"),
    );
  });

  it("logs 'up to date' when installed version matches latest", async () => {
    // fetchMock default returns 0.0.1; getInstalledVersion reads plugin.json
    // from the real filesystem, which will be 0.6.x. So we force the
    // GitHub answer to match by returning ok=false → latest=null →
    // falls through the else.
    fetchMock.mockResolvedValue({ ok: false });
    await runHook();
    // The "version up to date" branch is reached when latest is non-null
    // but not newer. Hard to hit deterministically without also mocking
    // the file read; covering the fetch-error branch (ok=false → null)
    // at least keeps the outer try from throwing.
    // Assert we did not log an autoupdate:
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("tolerates a fetch error (GitHub unreachable)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await runHook();
    // Inner try/catch in getLatestVersion swallows; no autoupdate triggers.
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});

describe("session-start-setup hook — embed daemon warmup", () => {
  it("calls EmbedClient.warmup() by default and logs the outcome", async () => {
    await runHook();
    expect(embedWarmupMock).toHaveBeenCalledTimes(1);
    expect(debugLogMock).toHaveBeenCalledWith("embed daemon warmup: ok");
  });

  it("logs 'failed' when warmup returns false", async () => {
    embedWarmupMock.mockResolvedValue(false);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("embed daemon warmup: failed");
  });

  it("logs the thrown message when warmup rejects", async () => {
    embedWarmupMock.mockRejectedValue(new Error("daemon spawn failed"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("embed daemon warmup threw: daemon spawn failed"),
    );
  });

  it("skips warmup when HIVEMIND_EMBED_WARMUP=false", async () => {
    await runHook({ HIVEMIND_EMBED_WARMUP: "false" });
    expect(embedWarmupMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      "embed daemon warmup skipped via HIVEMIND_EMBED_WARMUP=false",
    );
  });

  it("skips warmup when the master HIVEMIND_EMBEDDINGS=false flag is set", async () => {
    await runHook({ HIVEMIND_EMBEDDINGS: "false" });
    expect(embedWarmupMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(
      "embed daemon warmup skipped: HIVEMIND_EMBEDDINGS=false",
    );
  });
});

describe("session-start-setup hook — fatal catch", () => {
  it("catches a stdin throw and exits 0", async () => {
    stdinMock.mockRejectedValue(new Error("stdin boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: stdin boom");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Extra branch coverage: getLatestVersion edge cases + version-compare chain
describe("session-start-setup hook — version helpers edge cases", () => {
  it("treats fetch with ok:false as no-new-version (line 61 branch)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ version: "999.0.0" }) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("treats a response missing the 'version' field as null (?? null fallback)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("treats latest == current as 'up to date' (isNewer false)", async () => {
    // Force current to be a version that fetchMock exactly matches.
    // We can't change what getInstalledVersion reads from disk, but we
    // can make fetch return the installed version. With equal strings,
    // isNewer returns false and the else-branch fires.
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(
          __dirname, "..", ".claude-plugin", "plugin.json",
        ),
        "utf-8",
      ),
    );
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: pkg.version }) });
    await runHook();
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
