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
const readVirtualPathContentMock = vi.fn();
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
vi.mock("../../src/hooks/virtual-table-query.js", () => ({
  readVirtualPathContent: (...a: unknown[]) => readVirtualPathContentMock(...a),
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
  readVirtualPathContentMock.mockReset().mockResolvedValue(null);
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
    // The heredoc terminator is randomized per-call to prevent payload-driven
    // shell injection (see pickHeredocTerminator). We only check the marker
    // shape (prefix + hex), not its literal value.
    expect(payload.updated_input.command).toMatch(/cat <<'__HIVEMIND_RESULT_[a-f0-9]+__'/);
    expect(payload.updated_input.command).toContain("hit-line-1");
    expect(payload.agent_message).toContain("[Hivemind direct] needle");
  });

  it("randomizes the heredoc terminator across calls (no fixed marker)", async () => {
    // Two calls in a row must produce different terminators — locks in the
    // randomization so a future refactor can't silently regress to a fixed
    // literal that user content could collide with.
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "grep needle ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockResolvedValue("payload");

    await runHook();
    const first = JSON.parse(stdoutText()).updated_input.command;
    stdoutWriteMock.mockReset();
    await runHook();
    const second = JSON.parse(stdoutText()).updated_input.command;

    const markerOf = (s: string) => s.match(/__HIVEMIND_RESULT_[a-f0-9]+__/)?.[0];
    expect(markerOf(first)).toBeTruthy();
    expect(markerOf(second)).toBeTruthy();
    expect(markerOf(first)).not.toEqual(markerOf(second));
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

// ── cat / head / tail intercept (issue #88) ─────────────────────────────────
//
// Cursor's pre-tool-use historically only intercepted grep/rg. `cat
// ~/.deeplake/memory/index.md` fell through to the real filesystem and
// ENOENT'd even though the SessionStart preamble tells the agent to read
// index.md first. The new parseCatHeadTail branch routes those reads
// through readVirtualPathContent so the synthesized index is served.
describe("cursor pre-tool-use hook — cat / head / tail intercept", () => {
  // parseBashGrep returns null for non-grep commands; that's how the hook
  // falls through to the new read-intercept path.
  beforeEach(() => { parseBashGrepMock.mockReturnValue(null); });

  it("cat <path> → emits virtual content via the heredoc shape", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("INDEX\nrow1\nrow2");

    await runHook();

    const payload = JSON.parse(stdoutText());
    expect(payload.permission).toBe("allow");
    expect(payload.updated_input.command).toContain("INDEX\nrow1\nrow2");
    expect(payload.agent_message).toContain("cat");
  });

  it("head -N <path> → applies line limit", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "head -n 2 ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("a\nb\nc\nd\ne");

    await runHook();

    const payload = JSON.parse(stdoutText());
    // Heredoc body should hold just `a\nb`, not the full content.
    expect(payload.updated_input.command).toMatch(/\na\nb\n__HIVEMIND_RESULT/);
    expect(payload.agent_message).toContain("head -2");
  });

  it("tail -N <path> → takes last N lines", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "tail -n 2 ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("a\nb\nc\nd\ne");

    await runHook();

    const payload = JSON.parse(stdoutText());
    expect(payload.updated_input.command).toMatch(/\nd\ne\n__HIVEMIND_RESULT/);
    expect(payload.agent_message).toContain("tail -2");
  });

  it("readVirtualPathContent returning null → fall-through (no JSON, debug log)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "cat ~/.deeplake/memory/missing.md" },
    });
    readVirtualPathContentMock.mockResolvedValue(null);

    await runHook();

    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fallthrough"));
  });

  it("readVirtualPathContent throwing → silent fall-through (no JSON, debug log)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockRejectedValue(new Error("api down"));

    await runHook();

    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("read fast-path failed"));
  });

  it("unrecognized non-grep command → no-op (parseCatHeadTail returns null)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "Shell",
      tool_input: { command: "wc -l ~/.deeplake/memory/index.md" },
    });

    await runHook();

    expect(readVirtualPathContentMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });
});
