import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/hooks/hermes/pre-tool-use.ts.
 *
 * Hermes' pre_tool_call hook intercepts terminal commands aimed at
 * ~/.deeplake/memory and replies with `{action:"block", message:<sql result>}`.
 * Same boundary mocks as the cursor variant, with the action+message
 * shape asserted instead of the cursor `permission/updated_input` shape.
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
  await import("../../src/hooks/hermes/pre-tool-use.js");
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

describe("hermes pre-tool-use hook — guards", () => {
  it("non-terminal tool_name → no-op", async () => {
    stdinMock.mockResolvedValue({ tool_name: "browser", tool_input: { command: "x" } });
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });

  it("missing or empty command → no-op", async () => {
    stdinMock.mockResolvedValue({ tool_name: "terminal", tool_input: { command: "" } });
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
  });

  it("touchesMemory false → no-op", async () => {
    stdinMock.mockResolvedValue({ tool_name: "terminal", tool_input: { command: "ls" } });
    touchesMemoryMock.mockReturnValue(false);
    await runHook();
    expect(parseBashGrepMock).not.toHaveBeenCalled();
  });

  it("non-grep command → fall through (no SQL call)", async () => {
    stdinMock.mockResolvedValue({ tool_name: "terminal", tool_input: { command: "cat foo" } });
    parseBashGrepMock.mockReturnValue(null);
    await runHook();
    expect(handleGrepDirectMock).not.toHaveBeenCalled();
  });

  it("loadConfig null → silent fall through", async () => {
    stdinMock.mockResolvedValue({ tool_name: "terminal", tool_input: { command: "grep x ~/.deeplake/memory/" } });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(handleGrepDirectMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });
});

describe("hermes pre-tool-use hook — happy path", () => {
  it("emits {action:'block', message} containing the SQL result + MCP-tool nudge", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "grep needle ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockResolvedValue("hit-1\nhit-2");
    await runHook();
    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(stdoutText());
    expect(payload.action).toBe("block");
    expect(payload.message).toContain("hit-1");
    expect(payload.message).toContain("hit-2");
    expect(payload.message).toContain("hivemind_search MCP tool");
  });

  it("handleGrepDirect returns null → no JSON output (silent fall-through)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "grep zzz ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockResolvedValue(null);
    await runHook();
    expect(stdoutText()).toBe("");
  });

  it("handleGrepDirect throws → silent fall-through (debug log present)", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "grep x ~/.deeplake/memory/" },
    });
    handleGrepDirectMock.mockRejectedValue(new Error("net down"));
    await runHook();
    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fast-path failed"));
  });

  it("readStdin throwing → top-level catch arrow logs 'fatal' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin gone"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin gone"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ── cat / head / tail intercept (issue #88) ─────────────────────────────────
//
// Hermes' preToolCall hook now also serves `cat <path>` / `head -N <path>` /
// `tail -N <path>` reads via readVirtualPathContent, so the agent can
// actually fetch /index.md without the terminal command ENOENTing.
describe("hermes pre-tool-use hook — cat / head / tail intercept", () => {
  beforeEach(() => { parseBashGrepMock.mockReturnValue(null); });

  it("cat <path> → {action:'block', message:<content>}", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("INDEX\nrow1\nrow2");

    await runHook();

    const payload = JSON.parse(stdoutText());
    expect(payload.action).toBe("block");
    expect(payload.message).toBe("INDEX\nrow1\nrow2");
  });

  it("head -N <path> → message holds first N lines only", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "head -n 2 ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("a\nb\nc\nd");
    await runHook();
    expect(JSON.parse(stdoutText()).message).toBe("a\nb");
  });

  it("tail -N <path> → message holds last N lines only", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "tail -n 2 ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockResolvedValue("a\nb\nc\nd");
    await runHook();
    expect(JSON.parse(stdoutText()).message).toBe("c\nd");
  });

  it("readVirtualPathContent null → silent fall-through", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "cat ~/.deeplake/memory/missing.md" },
    });
    readVirtualPathContentMock.mockResolvedValue(null);
    await runHook();
    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fallthrough"));
  });

  it("readVirtualPathContent throws → silent fall-through with debug log", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "cat ~/.deeplake/memory/index.md" },
    });
    readVirtualPathContentMock.mockRejectedValue(new Error("api down"));
    await runHook();
    expect(stdoutText()).toBe("");
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("read fast-path failed"));
  });

  it("non-cat/head/tail command (e.g. wc) → no-op", async () => {
    stdinMock.mockResolvedValue({
      tool_name: "terminal",
      tool_input: { command: "wc -l ~/.deeplake/memory/index.md" },
    });
    await runHook();
    expect(readVirtualPathContentMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe("");
  });
});
