import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/hooks/hermes/capture.ts.
 *
 * Hermes payload places event-specific data in `extra` (not at the top level
 * like Claude/Cursor), so the capture handler does an `extra.foo ??
 * extra.bar` lookup per event. We exercise every variant + the
 * pre_llm_call branch's three prompt-source fallbacks.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const debugLogMock = vi.fn();
const queryMock = vi.fn();
const ensureSessionsTableMock = vi.fn();
const buildSessionPathMock = vi.fn();

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: (_tag: string, msg: string) => debugLogMock(msg) }));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class {
    query(sql: string) { return queryMock(sql); }
    ensureSessionsTable(t: string) { return ensureSessionsTableMock(t); }
  },
}));
vi.mock("../../src/embeddings/client.js", () => ({
  EmbedClient: class {
    embed(_text: string, _kind?: string) { return Promise.resolve(null); }
    warmup() { return Promise.resolve(false); }
  },
}));
vi.mock("../../src/utils/session-path.js", () => ({
  buildSessionPath: (...a: unknown[]) => buildSessionPathMock(...a),
}));

const validConfig = {
  token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
  userName: "alice", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

// Env keys + tmp dirs that tests in this file mutate via runHook(). The
// afterEach hook reads from these to restore the process env and clean
// up any tmp dirs the user-disabled-embeddings test creates — without
// it, the next test in the same vitest worker would inherit a stray
// HIVEMIND_CONFIG_PATH pointing at a (deleted) tmp file, which silently
// alters how the embeddings module resolves its on-disk config.
const TOUCHED_ENV_KEYS = [
  "HIVEMIND_CAPTURE",
  "HIVEMIND_CONFIG_PATH",
] as const;
const _origEnv: Record<string, string | undefined> = {};
const _tmpDirsToClean: string[] = [];

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  for (const k of TOUCHED_ENV_KEYS) {
    if (!(k in _origEnv)) _origEnv[k] = process.env[k];
  }
  delete process.env.HIVEMIND_CAPTURE;
  for (const [k, v] of Object.entries(env)) {
    if (!(k in _origEnv)) _origEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/hermes/capture.js");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  stdinMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  debugLogMock.mockReset();
  queryMock.mockReset().mockResolvedValue([]);
  ensureSessionsTableMock.mockReset().mockResolvedValue(undefined);
  buildSessionPathMock.mockReset().mockReturnValue("/sessions/alice/foo.jsonl");
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Restore env keys touched by runHook() so later tests start clean.
  for (const [k, v] of Object.entries(_origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(_origEnv)) delete _origEnv[k];
  // Clean any tmp dirs the user-disabled test created.
  if (_tmpDirsToClean.length > 0) {
    const { rmSync } = await import("node:fs");
    for (const d of _tmpDirsToClean) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    _tmpDirsToClean.length = 0;
  }
});

describe("hermes capture hook — guards", () => {
  it("HIVEMIND_CAPTURE=false → no stdin read", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("loadConfig null → 'no config' debug log + no INSERT", async () => {
    stdinMock.mockResolvedValue({ hook_event_name: "pre_llm_call" });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("hermes capture hook — pre_llm_call (user message)", () => {
  it("uses extra.prompt as the content source", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid",
      cwd: "/proj",
      extra: { prompt: "first" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"user_message"');
    expect(sql).toContain('"content":"first"');
    expect(sql).toContain("'hermes'");
  });

  it("falls back to extra.user_message when extra.prompt is absent", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid",
      extra: { user_message: "second" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"content":"second"');
  });

  it("falls back to extra.message.content as the third option", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid",
      extra: { message: { content: "third" } },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"content":"third"');
  });

  it("skipped (no INSERT) when no prompt source is found", async () => {
    stdinMock.mockResolvedValue({ hook_event_name: "pre_llm_call", session_id: "sid", extra: {} });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("no prompt found"));
  });
});

describe("hermes capture hook — post_tool_call (tool message)", () => {
  it("uses tool_name + extra.tool_result as the response", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "post_tool_call",
      session_id: "sid",
      tool_name: "terminal",
      tool_input: { command: "ls" },
      extra: { tool_result: "stdout-blob" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"tool_call"');
    expect(sql).toContain('"tool_name":"terminal"');
    expect(sql).toContain('"tool_response":"stdout-blob"');
  });

  it("falls back through extra.tool_output → extra.result → extra.output", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "post_tool_call",
      session_id: "sid",
      tool_name: "terminal",
      tool_input: {},
      extra: { output: "fallthrough-value" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"tool_response":"fallthrough-value"');
  });

  it("non-string tool response is JSON-stringified", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "post_tool_call",
      session_id: "sid",
      tool_name: "Read",
      tool_input: { path: "/x" },
      extra: { tool_result: { ok: true } },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"tool_response":"{\\"ok\\":true}"');
  });

  it("skipped when tool_name is missing (defensive)", async () => {
    stdinMock.mockResolvedValue({ hook_event_name: "post_tool_call", session_id: "sid", extra: {} });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("hermes capture hook — post_llm_call (assistant message)", () => {
  it("uses extra.response as the content", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "post_llm_call",
      session_id: "sid",
      extra: { response: "done" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"assistant_message"');
    expect(sql).toContain('"content":"done"');
  });

  it("falls back through extra.assistant_message → extra.message.content", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "post_llm_call",
      session_id: "sid",
      extra: { message: { content: "via-message-content" } },
    });
    await runHook();
    expect((queryMock.mock.calls[0][0] as string)).toContain('"content":"via-message-content"');
  });

  it("skipped when no response source is found", async () => {
    stdinMock.mockResolvedValue({ hook_event_name: "post_llm_call", session_id: "sid", extra: {} });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("no response found"));
  });
});

describe("hermes capture hook — unknown / failure paths", () => {
  it("unknown event → debug log + skip", async () => {
    stdinMock.mockResolvedValue({ hook_event_name: "weird", session_id: "sid", extra: {} });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("unknown/unhandled event: weird"));
  });

  it("retries via ensureSessionsTable on 'does not exist'", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call", session_id: "sid", extra: { prompt: "x" },
    });
    queryMock.mockRejectedValueOnce(new Error('does not exist')).mockResolvedValueOnce([]);
    await runHook();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("synthesises 'hermes-<ts>' session id when session_id is missing", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call", extra: { prompt: "x" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/"session_id":"hermes-\d+"/);
  });

  it("readStdin throwing → top-level catch arrow logs 'fatal' and exits 0", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdinMock.mockRejectedValue(new Error("stdin gone"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: stdin gone"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("hermes capture hook — message_embedding column", () => {
  it("INSERT carries the message_embedding column in the column list", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid-emb-1",
      cwd: "/work/proj",
      extra: { prompt: "embed me" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/\(id, path, filename, message, message_embedding,/);
  });

  it("emits NULL for the embedding value when EmbedClient returns null", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid-emb-2",
      cwd: "/work/proj",
      extra: { prompt: "no daemon" },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'::jsonb, NULL,");
  });

  it("user-disabled embeddings short-circuit to NULL without invoking EmbedClient", async () => {
    stdinMock.mockResolvedValue({
      hook_event_name: "pre_llm_call",
      session_id: "sid-emb-3",
      cwd: "/work/proj",
      extra: { prompt: "disabled" },
    });
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hermes-cap-disabled-"));
    _tmpDirsToClean.push(dir);
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ embeddings: { enabled: false } }), "utf-8");
    await runHook({ HIVEMIND_CONFIG_PATH: cfgPath });
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'::jsonb, NULL,");
    expect(sql).toMatch(/, message_embedding,/);
  });
});
