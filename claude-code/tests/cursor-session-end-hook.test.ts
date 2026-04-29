import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdinMock = vi.fn();
const debugLogMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/cursor/session-end.js");
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset().mockResolvedValue({});
  debugLogMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("cursor session-end hook (stub)", () => {
  it("HIVEMIND_WIKI_WORKER=1 → no stdin read", async () => {
    await runHook({ HIVEMIND_WIKI_WORKER: "1" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("logs session id, reason, and final_status when present", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "conv-7",
      reason: "user-quit",
      final_status: "completed",
    });
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=conv-7");
    expect(text).toContain("reason=user-quit");
    expect(text).toContain("status=completed");
  });

  it("falls back to session_id when conversation_id is missing", async () => {
    stdinMock.mockResolvedValue({ session_id: "ses-1" });
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("session=ses-1"));
  });

  it("falls back to '?' for missing session/reason/status fields", async () => {
    stdinMock.mockResolvedValue({});
    await runHook();
    const text = debugLogMock.mock.calls.map(c => c[0]).join("\n");
    expect(text).toContain("session=?");
    expect(text).toContain("reason=?");
    expect(text).toContain("status=?");
  });

  it("readStdin throwing → caught, logs 'fatal: ...' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin pipe died"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin pipe died"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
