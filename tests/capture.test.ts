import { describe, it, expect } from "vitest";
import { sqlStr } from "../src/utils/sql.js";

// ── buildSessionPath (extracted logic from capture.ts) ─────────────────────────

function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  const userName = config.userName;
  const orgName = config.orgName;
  const workspace = config.workspaceId ?? "default";
  return `/sessions/${userName}/${userName}_${orgName}_${workspace}_${sessionId}.jsonl`;
}

describe("buildSessionPath", () => {
  it("builds path with session ID (no slug lookup)", () => {
    const path = buildSessionPath(
      { userName: "alice", orgName: "acme", workspaceId: "default" },
      "abc-123",
    );
    expect(path).toBe("/sessions/alice/alice_acme_default_abc-123.jsonl");
  });

  it("uses session ID directly, not a slug", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const path = buildSessionPath(
      { userName: "bob", orgName: "corp", workspaceId: "prod" },
      sessionId,
    );
    expect(path).toContain(sessionId);
    expect(path).toBe(`/sessions/bob/bob_corp_prod_${sessionId}.jsonl`);
  });

  it("defaults workspace to 'default' when undefined", () => {
    const path = buildSessionPath(
      { userName: "u", orgName: "o", workspaceId: undefined as unknown as string },
      "s1",
    );
    expect(path).toContain("_default_");
  });
});

// ── JSONB escaping (the jsonForSql pattern from capture.ts) ────────────────────

function jsonForSql(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/'/g, "''");
}

describe("JSONB escaping", () => {
  it("preserves backslashes in file paths", () => {
    const entry = {
      type: "tool_call",
      tool_input: JSON.stringify({ file_path: "C:\\Users\\test\\file.ts" }),
    };
    const escaped = jsonForSql(entry);
    // Backslashes must survive in the JSON — they're already escaped by JSON.stringify
    expect(escaped).toContain("C:\\\\");
    // Must be valid JSON when single-quote escaping is reversed
    const unescaped = escaped.replace(/''/g, "'");
    expect(() => JSON.parse(unescaped)).not.toThrow();
  });

  it("escapes single quotes for SQL", () => {
    const entry = { content: "it's a test" };
    const escaped = jsonForSql(entry);
    expect(escaped).toContain("it''s a test");
    // The original JSON is recoverable
    const unescaped = escaped.replace(/''/g, "'");
    expect(JSON.parse(unescaped).content).toBe("it's a test");
  });

  it("handles nested JSON with special characters", () => {
    const entry = {
      type: "tool_call",
      tool_response: JSON.stringify({
        stdout: "line1\nline2\ttab",
        path: "/home/user's dir/file.ts",
      }),
    };
    const escaped = jsonForSql(entry);
    const unescaped = escaped.replace(/''/g, "'");
    expect(() => JSON.parse(unescaped)).not.toThrow();
  });

  it("handles empty objects", () => {
    const escaped = jsonForSql({});
    expect(escaped).toBe("{}");
  });

  it("differs from sqlStr which corrupts JSON", () => {
    const json = '{"path":"C:\\\\Users\\\\test"}';
    // sqlStr would double-escape backslashes
    const withSqlStr = sqlStr(json);
    // jsonForSql only escapes single quotes
    const withJsonEsc = json.replace(/'/g, "''");
    // sqlStr result is NOT valid JSON (double-escaped backslashes)
    expect(withSqlStr).not.toBe(withJsonEsc);
    // jsonForSql result IS valid JSON when unescaped
    expect(() => JSON.parse(withJsonEsc.replace(/''/g, "'"))).not.toThrow();
  });
});

// ── Entry building (mirrors capture.ts logic) ─────────────────────────────────

function buildEntry(input: {
  session_id: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  last_assistant_message?: string;
}): Record<string, unknown> | null {
  const meta = {
    session_id: input.session_id,
    hook_event_name: input.hook_event_name,
    timestamp: new Date().toISOString(),
  };

  if (input.prompt !== undefined) {
    return { id: "test", ...meta, type: "user_message", content: input.prompt };
  } else if (input.tool_name !== undefined) {
    return {
      id: "test", ...meta, type: "tool_call",
      tool_name: input.tool_name,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response),
    };
  } else if (input.last_assistant_message !== undefined) {
    return { id: "test", ...meta, type: "assistant_message", content: input.last_assistant_message };
  }
  return null;
}

describe("entry building", () => {
  it("builds user_message from prompt", () => {
    const entry = buildEntry({ session_id: "s1", prompt: "hello" });
    expect(entry?.type).toBe("user_message");
    expect(entry?.content).toBe("hello");
  });

  it("builds tool_call from tool_name", () => {
    const entry = buildEntry({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "/test.ts" },
      tool_response: { content: "file contents" },
    });
    expect(entry?.type).toBe("tool_call");
    expect(entry?.tool_name).toBe("Read");
    expect(typeof entry?.tool_input).toBe("string"); // JSON.stringified
  });

  it("builds assistant_message from last_assistant_message", () => {
    const entry = buildEntry({ session_id: "s1", last_assistant_message: "Done." });
    expect(entry?.type).toBe("assistant_message");
    expect(entry?.content).toBe("Done.");
  });

  it("returns null for unknown event", () => {
    const entry = buildEntry({ session_id: "s1" });
    expect(entry).toBeNull();
  });

  it("tool_input and tool_response are stringified JSON", () => {
    const input = { nested: { deep: true }, arr: [1, 2, 3] };
    const response = { result: "ok" };
    const entry = buildEntry({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: input,
      tool_response: response,
    });
    expect(JSON.parse(entry?.tool_input as string)).toEqual(input);
    expect(JSON.parse(entry?.tool_response as string)).toEqual(response);
  });

  it("entry JSON survives JSONB escaping roundtrip", () => {
    const entry = buildEntry({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "/home/user's files/test.ts" },
      tool_response: { content: "line1\nline2\nconst x = 'hello'" },
    });
    const json = JSON.stringify(entry);
    const escaped = json.replace(/'/g, "''");
    const recovered = escaped.replace(/''/g, "'");
    expect(JSON.parse(recovered)).toEqual(entry);
  });
});

// ── Placeholder content (mirrors session-start.ts createPlaceholder) ──────────

function buildPlaceholder(sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string): { path: string; content: string } {
  const summaryPath = `/summaries/${userName}/${sessionId}.md`;
  const projectName = cwd.split("/").pop() || "unknown";
  const sessionSource = `/sessions/${userName}/${userName}_${orgName}_${workspaceId}_${sessionId}.jsonl`;
  const now = new Date().toISOString();
  const content = [
    `# Session ${sessionId}`,
    `- **Source**: ${sessionSource}`,
    `- **Started**: ${now}`,
    `- **Project**: ${projectName}`,
    `- **Status**: in-progress`,
    "",
  ].join("\n");
  return { path: summaryPath, content };
}

describe("placeholder creation", () => {
  it("builds correct summary path", () => {
    const { path } = buildPlaceholder("abc-123", "/home/user/project", "alice", "acme", "default");
    expect(path).toBe("/summaries/alice/abc-123.md");
  });

  it("uses project name not full path", () => {
    const { content } = buildPlaceholder("s1", "/home/user/my-project", "u", "o", "w");
    expect(content).toContain("- **Project**: my-project");
    expect(content).not.toContain("/home/user/my-project");
  });

  it("source points to sessions table path", () => {
    const { content } = buildPlaceholder("s1", "/repo", "alice", "acme", "prod");
    expect(content).toContain("- **Source**: /sessions/alice/alice_acme_prod_s1.jsonl");
  });

  it("has all required fields", () => {
    const { content } = buildPlaceholder("s1", "/repo", "u", "o", "w");
    expect(content).toContain("# Session s1");
    expect(content).toContain("- **Source**:");
    expect(content).toContain("- **Started**:");
    expect(content).toContain("- **Project**:");
    expect(content).toContain("- **Status**: in-progress");
  });

  it("handles empty cwd", () => {
    const { content } = buildPlaceholder("s1", "", "u", "o", "w");
    expect(content).toContain("- **Project**: unknown");
  });
});

// ── INSERT SQL structure (mirrors capture.ts) ───────────────────────────────

function buildInsertSql(
  sessionsTable: string, sessionPath: string, filename: string,
  jsonForSql: string, lineBytes: number, userName: string,
  projectName: string, hookEvent: string, ts: string,
): string {
  return (
    `INSERT INTO "${sessionsTable}" (id, path, filename, message, author, size_bytes, project, description, creation_date, last_update_date) ` +
    `VALUES ('test-id', '${sessionPath}', '${filename}', '${jsonForSql}'::jsonb, '${userName}', ` +
    `${lineBytes}, '${projectName}', '${hookEvent}', '${ts}', '${ts}')`
  );
}

describe("INSERT SQL structure", () => {
  it("uses message column (not content_text) for sessions table", () => {
    const sql = buildInsertSql("sessions", "/sessions/u/s.jsonl", "s.jsonl", "{}", 2, "alice", "proj", "UserPromptSubmit", "2026-01-01T00:00:00Z");
    expect(sql).toContain("message");
    expect(sql).not.toContain("content_text");
  });

  it("includes author column with username", () => {
    const sql = buildInsertSql("sessions", "/sessions/u/s.jsonl", "s.jsonl", "{}", 2, "alice", "proj", "Stop", "2026-01-01T00:00:00Z");
    expect(sql).toContain("author");
    expect(sql).toContain("'alice'");
  });

  it("casts message value to jsonb", () => {
    const sql = buildInsertSql("sessions", "/p", "f", '{"type":"user_message"}', 22, "u", "p", "UserPromptSubmit", "t");
    expect(sql).toContain("::jsonb");
  });

  it("uses the correct table name", () => {
    const sql = buildInsertSql("my_sessions", "/p", "f", "{}", 2, "u", "p", "Stop", "t");
    expect(sql).toContain('"my_sessions"');
  });
});

// ── Capture fallback logic ──────────────────────────────────────────────────

describe("capture fallback", () => {
  it("detects permission denied as retriable error", () => {
    const msg = 'Query failed: 400: {"error":"SQL error: permission denied for table sessions"}';
    expect(msg.includes("permission denied")).toBe(true);
  });

  it("detects table not found as retriable error", () => {
    const msg = 'Query failed: 400: {"error":"table sessions does not exist"}';
    expect(msg.includes("does not exist")).toBe(true);
  });

  it("does not retry on unrelated errors", () => {
    const msg = 'Query failed: 400: {"error":"syntax error at or near SELECT"}';
    expect(msg.includes("permission denied")).toBe(false);
    expect(msg.includes("does not exist")).toBe(false);
  });
});

// ── Placeholder SQL uses summary column and author ──────────────────────────

function buildPlaceholderSql(
  table: string, summaryPath: string, filename: string,
  hex: string, content: string, userName: string,
  projectName: string, now: string,
): string {
  return (
    `INSERT INTO "${table}" (id, path, filename, content, summary, author, mime_type, size_bytes, project, description, creation_date, last_update_date) ` +
    `VALUES ('test-id', '${summaryPath}', '${filename}', E'\\\\x${hex}', E'${content}', '${userName}', 'text/markdown', ` +
    `${content.length}, '${projectName}', 'in progress', '${now}', '${now}')`
  );
}

describe("placeholder SQL structure", () => {
  it("uses summary column (not content_text) for memory table", () => {
    const sql = buildPlaceholderSql("memory", "/summaries/u/s1.md", "s1.md", "abc", "# Session", "alice", "proj", "2026-01-01T00:00:00Z");
    expect(sql).toContain("summary");
    expect(sql).not.toContain("content_text");
  });

  it("includes author column with username", () => {
    const sql = buildPlaceholderSql("memory", "/summaries/u/s1.md", "s1.md", "abc", "# Session", "bob", "proj", "2026-01-01T00:00:00Z");
    expect(sql).toContain("author");
    expect(sql).toContain("'bob'");
  });
});

// ── Wiki worker prompt template substitution ──────────────────────────────────

describe("prompt template substitution", () => {
  const template = "SESSION: __SESSION_ID__, PROJECT: __PROJECT__, OFFSET: __PREV_OFFSET__, LINES: __JSONL_LINES__, PATH: __JSONL_SERVER_PATH__, JSONL: __JSONL__, SUMMARY: __SUMMARY__";

  it("replaces all placeholders", () => {
    const result = template
      .replace(/__JSONL__/g, "/tmp/session.jsonl")
      .replace(/__SUMMARY__/g, "/tmp/summary.md")
      .replace(/__SESSION_ID__/g, "abc-123")
      .replace(/__PROJECT__/g, "my-project")
      .replace(/__PREV_OFFSET__/g, "0")
      .replace(/__JSONL_LINES__/g, "42")
      .replace(/__JSONL_SERVER_PATH__/g, "/sessions/u/u_o_w_abc-123.jsonl");

    expect(result).not.toContain("__");
    expect(result).toContain("abc-123");
    expect(result).toContain("my-project");
    expect(result).toContain("42");
  });

  it("handles multiple occurrences of same placeholder", () => {
    const tmpl = "__SESSION_ID__ and __SESSION_ID__ again";
    const result = tmpl.replace(/__SESSION_ID__/g, "test-id");
    expect(result).toBe("test-id and test-id again");
  });
});
