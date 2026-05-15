import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/hooks/cursor/capture.ts.
 *
 * Cursor's capture hook wires four event types onto the same INSERT path:
 * beforeSubmitPrompt, postToolUse, afterAgentResponse, stop. Each branch
 * builds a different `entry` shape; we drive each branch and assert SQL
 * SHAPE + COUNT (CLAUDE.md rule 6) so a regression that skips a branch
 * or mis-types an entry cannot slip through.
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

async function runHook(env: Record<string, string | undefined> = {}): Promise<void> {
  delete process.env.HIVEMIND_CAPTURE;
  delete process.env.HIVEMIND_WIKI_WORKER;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await import("../../src/hooks/cursor/capture.js");
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

afterEach(() => { vi.restoreAllMocks(); });

describe("cursor capture hook — guards", () => {
  it("HIVEMIND_CAPTURE=false → no-op (no stdin read)", async () => {
    await runHook({ HIVEMIND_CAPTURE: "false" });
    expect(stdinMock).not.toHaveBeenCalled();
  });

  it("loadConfig null → debug log 'no config' and no INSERT", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "c", hook_event_name: "stop" });
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("cursor capture hook — event branches", () => {
  it("beforeSubmitPrompt with a string prompt: INSERT contains type=user_message and the prompt", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-1",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "hello cursor",
      workspace_roots: ["/work/proj"],
    });
    await runHook();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO "sessions"/);
    expect(sql).toContain('"type":"user_message"');
    expect(sql).toContain('"content":"hello cursor"');
    expect(sql).toContain("'cursor'");
  });

  it("postToolUse: INSERT serialises tool_input/tool_response and carries tool_name", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-2",
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      tool_output: '{"stdout":"ok"}',
      workspace_roots: ["/work/proj"],
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"tool_call"');
    expect(sql).toContain('"tool_name":"Shell"');
    // Cursor delivers tool_output already as a JSON-encoded string, so the
    // value is plumbed through without a re-stringify.
    expect(sql).toContain('"tool_response":"{\\"stdout\\":\\"ok\\"}"');
  });

  it("postToolUse with non-string tool_output is JSON-stringified before insert", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-2b",
      hook_event_name: "postToolUse",
      tool_name: "Read",
      tool_input: { path: "/x" },
      tool_output: { lines: 42 },
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"tool_response":"{\\"lines\\":42}"');
  });

  it("afterAgentResponse: INSERT contains type=assistant_message and the text", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-3",
      hook_event_name: "afterAgentResponse",
      text: "here is a plan",
      workspace_roots: ["/w"],
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"assistant_message"');
    expect(sql).toContain('"content":"here is a plan"');
  });

  it("stop: INSERT contains status, loop_count, and 'stop' description", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-4",
      hook_event_name: "stop",
      status: "completed",
      loop_count: 3,
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"type":"stop"');
    expect(sql).toContain('"status":"completed"');
    expect(sql).toContain('"loop_count":3');
    expect(sql).toContain("'stop'");
  });

  it("unknown hook_event_name → debug log + skip", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "weird-event" });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("unknown event: weird-event"));
  });

  it("beforeSubmitPrompt without a string prompt: skipped (defensive)", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "beforeSubmitPrompt" });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("postToolUse without a string tool_name: skipped (defensive)", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "postToolUse" });
    await runHook();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("cursor capture hook — cwd + project resolution", () => {
  it("uses input.cwd when provided", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "x",
      cwd: "/explicit/cwd",
      workspace_roots: ["/should/be/ignored"],
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'cwd'");
  });

  it("falls back to workspace_roots[0] when cwd is missing", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "x",
      workspace_roots: ["/a/b/projname"],
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'projname'");
  });

  it("fills projectName='unknown' when neither cwd nor workspace_roots are present", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "x",
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'unknown'");
  });
});

describe("cursor capture hook — INSERT failure handling", () => {
  it("retries with ensureSessionsTable on 'does not exist' error", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "stop", status: "ok" });
    queryMock
      .mockRejectedValueOnce(new Error('relation "sessions" does not exist'))
      .mockResolvedValueOnce([]);
    await runHook();
    expect(ensureSessionsTableMock).toHaveBeenCalledWith("sessions");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 'permission denied' too", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "stop", status: "ok" });
    queryMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce([]);
    await runHook();
    expect(ensureSessionsTableMock).toHaveBeenCalled();
  });

  it("re-throws an unrelated error (which the outer .catch turns into a debug log + exit 0)", async () => {
    stdinMock.mockResolvedValue({ conversation_id: "x", hook_event_name: "stop", status: "ok" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    queryMock.mockRejectedValue(new Error("syntax error"));
    await runHook();
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining("fatal: syntax error"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("cursor capture hook — message_embedding column", () => {
  it("INSERT carries the message_embedding column in the column list", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-emb-1",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "embed me",
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/\(id, path, filename, message, message_embedding,/);
  });

  it("emits NULL for the embedding value when EmbedClient returns null", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-emb-2",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "no daemon",
    });
    await runHook();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'::jsonb, NULL,");
  });

  it("HIVEMIND_EMBEDDINGS=false short-circuits to NULL without invoking EmbedClient", async () => {
    stdinMock.mockResolvedValue({
      conversation_id: "sid-emb-3",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "disabled",
    });
    await runHook({ HIVEMIND_EMBEDDINGS: "false" });
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("'::jsonb, NULL,");
    expect(sql).toMatch(/, message_embedding,/);
  });
});
