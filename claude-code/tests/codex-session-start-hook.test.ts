import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Source-level tests for src/hooks/codex/session-start.ts. Codex has
 * no async-hook mechanism, so this fast-path hook synchronously reads
 * creds, emits context on stdout, and SPAWNS a detached node process
 * running session-start-setup.js for the heavy work.
 *
 * Mocks: readStdin, loadCredentials, and child_process.spawn. The
 * spawn mock returns a fake child with a writable stdin and an
 * unref() method so the hook body can drive it end-to-end without
 * actually forking a process.
 */

const stdinMock = vi.fn();
const loadCredsMock = vi.fn();
const debugLogMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: any[]) => stdinMock(...a) }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: (...a: any[]) => loadCredsMock(...a),
}));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_t: string, msg: string) => debugLogMock(msg),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...a: any[]) => spawnMock(...a) };
});

function makeFakeChild() {
  const stdin = new EventEmitter() as any;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  return {
    stdin,
    unref: vi.fn(),
  };
}

async function runHook(env: Record<string, string | undefined> = {}): Promise<string | null> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const collected: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { collected.push(args.join(" ")); };
  try {
    await import("../../src/hooks/codex/session-start.js");
    await new Promise(r => setImmediate(r));
    return collected.join("\n") || null;
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({
    session_id: "sid-1", cwd: "/x", hook_event_name: "SessionStart", model: "gpt-5",
  });
  loadCredsMock.mockReset().mockReturnValue({
    token: "tok", orgId: "org-id", orgName: "acme", userName: "alice", workspaceId: "default",
  });
  debugLogMock.mockReset();
  spawnMock.mockReset().mockImplementation(() => makeFakeChild());
});

afterEach(() => { vi.restoreAllMocks(); });

describe("codex session-start hook — guards", () => {
  it("returns immediately when HIVEMIND_WIKI_WORKER=1 (nested worker)", async () => {
    const out = await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("emits not-logged-in context when creds are missing (no token)", async () => {
    loadCredsMock.mockReturnValue(null);
    const out = await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(out).toContain("Not logged in to Deeplake");
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("no credentials found"),
    );
  });

  it("logs org name when creds are present", async () => {
    const out = await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("credentials loaded: org=acme"),
    );
    expect(out).toContain("Logged in to Deeplake as org: acme");
    expect(out).toContain("workspace: default");
  });

  it("falls back to orgId when orgName is missing", async () => {
    loadCredsMock.mockReturnValue({
      token: "tok", orgId: "org-uuid-123", userName: "alice", workspaceId: "staging",
    });
    const out = await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining("credentials loaded: org=org-uuid-123"),
    );
    expect(out).toContain("Logged in to Deeplake as org: org-uuid-123");
    expect(out).toContain("workspace: staging");
  });

  it("defaults workspace to 'default' when creds omit workspaceId", async () => {
    loadCredsMock.mockReturnValue({
      token: "tok", orgId: "o", orgName: "acme", userName: "alice",
    });
    const out = await runHook();
    expect(out).toContain("workspace: default");
  });
});

describe("codex session-start hook — spawn async setup", () => {
  it("spawns session-start-setup.js and feeds the same stdin input", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    await runHook();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("node");
    expect(args[0]).toContain("session-start-setup.js");
    expect(opts.detached).toBe(true);
    expect(fake.stdin.write).toHaveBeenCalledWith(expect.stringContaining("sid-1"));
    expect(fake.stdin.end).toHaveBeenCalled();
    expect(fake.unref).toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("spawned async setup process");
  });

  it("does not spawn when creds are missing", async () => {
    loadCredsMock.mockReturnValue({ token: "" });
    await runHook();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("codex session-start hook — fatal catch", () => {
  it("catches a stdin throw and exits 0", async () => {
    stdinMock.mockRejectedValue(new Error("stdin boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: stdin boom");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("codex session-start hook — spawn pipes the hook input verbatim", () => {
  it("forwards the full CodexSessionStartInput JSON to the setup process stdin", async () => {
    // The detached setup process parses the SAME stdin input that was
    // fed to this hook. If the contract breaks (e.g. we re-serialize a
    // subset), the async setup would receive a different payload and
    // the placeholder row would have the wrong session/cwd. Assert the
    // exact JSON round-trips.
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const customInput = {
      session_id: "custom-sid", cwd: "/custom/path",
      hook_event_name: "SessionStart", model: "gpt-5", source: "codex-cli",
    };
    stdinMock.mockResolvedValue(customInput);
    await runHook();
    const written = fake.stdin.write.mock.calls[0][0];
    expect(JSON.parse(written)).toMatchObject(customInput);
  });
});
