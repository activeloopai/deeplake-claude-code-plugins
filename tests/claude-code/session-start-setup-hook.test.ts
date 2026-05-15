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
const autoUpdateMock = vi.fn();
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
vi.mock("../../src/hooks/shared/autoupdate.js", () => ({
  autoUpdate: (...a: any[]) => autoUpdateMock(...a),
}));
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    async warmup() { return embedWarmupMock(); }
  },
}));
// `embeddingsDisabled()` walks the real filesystem looking for
// @huggingface/transformers, which is no longer in this repo's node_modules
// (it's installed once into ~/.hivemind/embed-deps via `hivemind embeddings
// install`). Without this mock the warmup branch is never reached and every
// assertion below would land on the "skipped: no-transformers" log line. We
// still respect HIVEMIND_EMBEDDINGS=false so the master-flag branch test below
// behaves like production.
vi.mock("../../src/embeddings/disable.js", () => ({
  embeddingsDisabled: () => process.env.HIVEMIND_EMBEDDINGS === "false",
  embeddingsStatus: () =>
    process.env.HIVEMIND_EMBEDDINGS === "false" ? "disabled-by-env" : "enabled",
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
  autoUpdateMock.mockReset().mockResolvedValue(undefined);
  embedWarmupMock.mockReset().mockResolvedValue(true);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ version: "0.0.1" }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("session-start-setup hook — centralized autoupdate", () => {
  // The autoUpdate helper is exhaustively tested in autoupdate.test.ts.
  // Here we only verify the hook calls it correctly (right agent ID) and
  // doesn't reach for the legacy version-check / execSync / GitHub-raw
  // probe.

  it("invokes autoUpdate exactly once with agent: 'claude'", async () => {
    await runHook();
    expect(autoUpdateMock).toHaveBeenCalledTimes(1);
    expect(autoUpdateMock.mock.calls[0][1]).toEqual({ agent: "claude" });
  });

  it("does not call fetch (legacy GitHub-raw version probe)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    await runHook();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("autoUpdate fires BEFORE the table-setup ensureTable call", async () => {
    let autoUpdateAt = -1;
    let ensureTableAt = -1;
    let counter = 0;
    autoUpdateMock.mockImplementation(async () => { autoUpdateAt = counter++; });
    ensureTableMock.mockImplementation(async () => { ensureTableAt = counter++; });
    await runHook();
    expect(autoUpdateAt).toBeGreaterThanOrEqual(0);
    expect(ensureTableAt).toBeGreaterThanOrEqual(0);
    expect(autoUpdateAt).toBeLessThan(ensureTableAt);
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

// (Version-helper edge cases — fetch ok:false, missing version field,
// isNewer comparison — are tested at the layer they belong to:
// `src/cli/update.ts` and the autoUpdate helper itself, not in the
// per-agent setup hook.)
