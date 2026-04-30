import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/hooks/cursor/pre-tool-use.ts.
 *
 * The hook intercepts `Shell` tool calls aimed at ~/.deeplake/memory and
 * rewrites them into an `echo` containing the SQL fast-path result. We
 * mock every collaborator at the boundary (CLAUDE.md rule 5):
 *   - readStdin / loadConfig / DeeplakeApi / debug log
 *   - touchesMemory / rewritePaths / parseBashGrep / handleGrepDirect
 * and assert that the right output JSON shape is emitted on stdout AND
 * that the fall-through branches stay silent.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const touchesMemoryMock = vi.fn();
const rewritePathsMock = vi.fn();
const parseBashGrepMock = vi.fn();
const handleGrepDirectMock = vi.fn();
const stdoutWriteMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class { constructor(..._: unknown[]) {} },
}));
vi.mock("../../src/hooks/grep-direct.js", () => ({
  parseBashGrep: (...a: unknown[]) => parseBashGrepMock(...a),
  handleGrepDirect: (...a: unknown[]) => handleGrepDirectMock(...a),
}));
vi.mock("../../src/hooks/memory-path-utils.js", () => ({
  touchesMemory: (...a: unknown[]) => touchesMemoryMock(...a),
  rewritePaths: (...a: unknown[]) => rewritePathsMock(...a),
}));

const validConfig = {
  token: "t", apiUrl: "http://example", orgId: "o", workspaceId: "w",
  tableName: "memory", sessionsTableName: "sessions",
};

async function runHook(): Promise<void> {
  vi.resetModules();
  await import("../../src/hooks/cursor/pre-tool-use.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  touchesMemoryMock.mockReset().mockReturnValue(true);
  rewritePathsMock.mockReset().mockImplementation((s: string) => s);
  parseBashGrepMock.mockReset().mockReturnValue({ pattern: "needle" });
  handleGrepDirectMock.mockReset().mockResolvedValue("ranked hits here");
  stdoutWriteMock.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { stdoutWriteMock(s); return true; }) as any);
});

afterEach(() => { vi.restoreAllMocks(); });

const stdoutText = () => stdoutWriteMock.mock.calls.map(c => c[0]).join("");

describe("cursor pre-tool-use hook — guard branches", () => {
  it("non-Shell tool_name → no-op (no parse, no SQL)", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Read", tool_input: { command: "x" } });
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
    expect(handleGrepDirectMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });

  it("missing command → no-op", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Shell", tool_input: {} });
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
  });

  it("empty-string command → no-op", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Shell", tool_input: { command: "" } });
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
  });

  it("touchesMemory false → no-op (not aimed at our mount)", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Shell", tool_input: { command: "ls /tmp" } });
    touchesMemoryMock.mockReturnValue(false);
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
  });

  it("parseBashGrep returns null → no-op (not a grep we can handle)", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Shell", tool_input: { command: "cat foo" } });
    parseBashGrepMock.mockReturnValue(null);
    await runHook();
    expect(handleGrepDirectMock).not.toHaveBeenCalled();
  });

  it("loadConfig null → fall-through (no SQL, no stdout JSON)", async () => {
    stdinMock.mockResolvedValue({ tool_name: "Shell", tool_input: { command: "grep x ~/.deeplake/memory/" } });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(handleGrepDirectMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });
});

describe("cursor pre-tool-use hook — happy path interception", () => {
  it("emits a JSON allow-with-rewrite reply when handleGrepDirect returns a non-null result", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "grep needle ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockResolvedValue("hit-line-1\nhit-line-2");

    await runHook();

    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(stdoutText());
    expect(payload.permission).toBe("allow");
    expect(typeof payload.updated_input.command).toBe("string");
    expect(payload.updated_input.command).toContain("__HIVEMIND_RESULT__");
    expect(payload.updated_input.command).toContain("hit-line-1");
    expect(payload.agent_message).toContain("[Hivemind direct] needle");
  });

  it("returns null from handleGrepDirect → debug log fall-through, no stdout JSON", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "grep zzz ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockResolvedValue(null);
    await runHook();
    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fallthrough"));
  });

  it("handleGrepDirect throwing → silent fall-through (no JSON reply, debug logged)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "grep x ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockRejectedValue(new Error("api down"));
    await runHook();
    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fast-path failed"));
  });

  it("rewritePaths is called before parseBashGrep (memory-path → virtual / translation)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "grep needle $HOME/.deeplake/memory/" },
    });
    await runHook();
    expect(rewritePathsMock).toHaveBeenCalledTimes(1);
    expect(rewritePathsMock).toHaveBeenCalledWith("grep needle $HOME/.deeplake/memory/");
    // parseBashGrep was called on the rewritten output (we identity-mock above).
    expect(parseBashGrepMock).toHaveBeenCalledWith("grep needle $HOME/.deeplake/memory/");
  });

  it("readStdin throwing → caught, logs 'fatal: ...' and exits 0 (top-level catch arrow)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin gone"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin gone"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
