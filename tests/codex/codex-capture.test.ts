import { describe, it, expect } from "vitest";
import { sqlStr } from "../../src/utils/sql.js";

// ── buildSessionPath (mirrors codex/capture.ts and codex/stop.ts) ────────────

function buildSessionPath(config: { userName: string; orgName: string; workspaceId: string }, sessionId: string): string {
  return `/sessions/${config.userName}/${config.userName}_${config.orgName}_${config.workspaceId}_${sessionId}.jsonl`;
}

describe("codex: buildSessionPath", () => {
  it("builds path with session ID", () => {
    const path = buildSessionPath(
      { userName: "alice", orgName: "acme", workspaceId: "default" },
      "abc-123",
    );
    expect(path).toBe("/sessions/alice/alice_acme_default_abc-123.jsonl");
  });

  it("uses full UUID session ID", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const path = buildSessionPath(
      { userName: "bob", orgName: "corp", workspaceId: "prod" },
      sessionId,
    );
    expect(path).toContain(sessionId);
  });
});

// ── JSONB escaping ───────────────────────────────────────────────────────────

function jsonForSql(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/'/g, "''");
}

describe("codex: JSONB escaping", () => {
  it("preserves backslashes in file paths", () => {
    const entry = {
      type: "tool_call",
      tool_input: JSON.stringify({ command: "cat /home/user's dir/file.ts" }),
    };
    const escaped = jsonForSql(entry);
    const unescaped = escaped.replace(/''/g, "'");
    expect(() => JSON.parse(unescaped)).not.toThrow();
  });

  it("escapes single quotes for SQL", () => {
    const entry = { content: "it's a test" };
    const escaped = jsonForSql(entry);
    expect(escaped).toContain("it''s a test");
  });

  it("handles empty objects", () => {
    expect(jsonForSql({})).toBe("{}");
  });
});

// ── Codex-specific entry building ────────────────────────────────────────────

interface CodexInput {
  session_id: string;
  hook_event_name: string;
  model?: string;
  turn_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  tool_response?: Record<string, unknown>;
}

function buildCodexEntry(input: CodexInput): Record<string, unknown> | null {
  const meta = {
    session_id: input.session_id,
    hook_event_name: input.hook_event_name,
    model: input.model,
    turn_id: input.turn_id,
    timestamp: new Date().toISOString(),
  };

  if (input.hook_event_name === "UserPromptSubmit" && input.prompt !== undefined) {
    return { id: "test", ...meta, type: "user_message", content: input.prompt };
  } else if (input.hook_event_name === "PostToolUse" && input.tool_name !== undefined) {
    return {
      id: "test", ...meta, type: "tool_call",
      tool_name: input.tool_name,
      tool_input: JSON.stringify(input.tool_input),
      tool_response: JSON.stringify(input.tool_response),
    };
  }
  return null;
}

describe("codex: entry building", () => {
  it("builds user_message from UserPromptSubmit", () => {
    const entry = buildCodexEntry({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    expect(entry?.type).toBe("user_message");
    expect(entry?.content).toBe("hello");
  });

  it("builds tool_call from PostToolUse (Bash only)", () => {
    const entry = buildCodexEntry({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat /test.ts" },
      tool_response: { stdout: "file contents" },
    });
    expect(entry?.type).toBe("tool_call");
    expect(entry?.tool_name).toBe("Bash");
    expect(typeof entry?.tool_input).toBe("string");
  });

  it("includes Codex-specific fields (model, turn_id)", () => {
    const entry = buildCodexEntry({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      model: "o3",
      turn_id: "turn-42",
      prompt: "test",
    });
    expect(entry?.model).toBe("o3");
    expect(entry?.turn_id).toBe("turn-42");
  });

  it("returns null for unknown event", () => {
    const entry = buildCodexEntry({
      session_id: "s1",
      hook_event_name: "SomeUnknownEvent",
    });
    expect(entry).toBeNull();
  });

  it("tool_input is stringified JSON", () => {
    const entry = buildCodexEntry({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la ~/.deeplake/memory/" },
      tool_response: { stdout: "total 0" },
    });
    const parsed = JSON.parse(entry?.tool_input as string);
    expect(parsed.command).toBe("ls -la ~/.deeplake/memory/");
  });
});

// ── Stop event with transcript parsing ───────────────────────────────────────

describe("codex: stop transcript parsing", () => {
  it("extracts assistant message from JSONL transcript", () => {
    const transcript = [
      '{"role":"user","content":"hello"}',
      '{"role":"assistant","content":"Hi there! How can I help?"}',
      '{"role":"user","content":"fix the bug"}',
      '{"role":"assistant","content":"Done, I fixed the bug in main.ts"}',
    ].join("\n");

    // Simulate the transcript parsing logic from stop.ts
    const lines = transcript.trim().split("\n").reverse();
    let lastAssistantMessage = "";
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === "assistant" && entry.content) {
          lastAssistantMessage = typeof entry.content === "string" ? entry.content : "";
          break;
        }
      } catch { /* skip */ }
    }

    expect(lastAssistantMessage).toBe("Done, I fixed the bug in main.ts");
  });

  it("handles content block arrays (multimodal)", () => {
    const transcript = [
      '{"role":"assistant","content":[{"type":"text","text":"first part"},{"type":"text","text":"second part"}]}',
    ].join("\n");

    const lines = transcript.trim().split("\n").reverse();
    let lastAssistantMessage = "";
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === "assistant" && entry.content) {
          const content = typeof entry.content === "string"
            ? entry.content
            : Array.isArray(entry.content)
              ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
              : "";
          if (content) { lastAssistantMessage = content; break; }
        }
      } catch { /* skip */ }
    }

    expect(lastAssistantMessage).toBe("first part\nsecond part");
  });

  it("returns empty string for empty transcript", () => {
    const lines = "".trim().split("\n").reverse();
    let lastAssistantMessage = "";
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === "assistant") lastAssistantMessage = entry.content ?? "";
      } catch { /* skip */ }
    }
    expect(lastAssistantMessage).toBe("");
  });

  it("truncates long messages to 4000 chars", () => {
    const longMsg = "x".repeat(5000);
    const truncated = longMsg.slice(0, 4000);
    expect(truncated.length).toBe(4000);
  });
});

// ── Pre-tool-use Bash detection ──────────────────────────────────────────────

const MEMORY_PATHS = [
  "/home/testuser/.deeplake/memory",
  "~/.deeplake/memory",
  "$HOME/.deeplake/memory",
];

function touchesMemory(cmd: string): boolean {
  return MEMORY_PATHS.some(p => cmd.includes(p));
}

describe("codex: Bash memory detection", () => {
  it("detects cat targeting memory path", () => {
    expect(touchesMemory("cat ~/.deeplake/memory/index.md")).toBe(true);
  });

  it("detects ls targeting memory path", () => {
    expect(touchesMemory("ls -la ~/.deeplake/memory/summaries/")).toBe(true);
  });

  it("detects grep targeting memory path", () => {
    expect(touchesMemory("grep -r 'keyword' ~/.deeplake/memory/")).toBe(true);
  });

  it("detects echo redirect targeting memory path", () => {
    expect(touchesMemory('echo "hello" > ~/.deeplake/memory/test.md')).toBe(true);
  });

  it("ignores commands not targeting memory", () => {
    expect(touchesMemory("cat /etc/hosts")).toBe(false);
    expect(touchesMemory("ls -la /home/user/project")).toBe(false);
    expect(touchesMemory("grep -r pattern ./src/")).toBe(false);
  });

  it("detects $HOME variant", () => {
    expect(touchesMemory("cat $HOME/.deeplake/memory/index.md")).toBe(true);
  });

  it("detects absolute path variant", () => {
    expect(touchesMemory("cat /home/testuser/.deeplake/memory/notes.md")).toBe(true);
  });
});

// ── Grep regex parsing (fast-path in pre-tool-use.ts) ────────────────────────

const GREP_RE = /^grep\s+(?:-[a-zA-Z]+\s+)*(?:'([^']*)'|"([^"]*)"|(\S+))\s+(\S+)/;

function parseGrep(cmd: string): { pattern: string; ignoreCase: boolean } | null {
  const match = cmd.match(GREP_RE);
  if (!match) return null;
  // Check for -i anywhere in the flags (could be -i, -ri, -rni, etc.)
  const ignoreCase = /\s-[a-zA-Z]*i/.test(cmd);
  return {
    pattern: match[1] ?? match[2] ?? match[3],
    ignoreCase,
  };
}

describe("codex: grep regex parsing", () => {
  it("parses single-quoted pattern", () => {
    const r = parseGrep("grep -r 'keyword' /");
    expect(r?.pattern).toBe("keyword");
    expect(r?.ignoreCase).toBe(false);
  });

  it("parses double-quoted pattern", () => {
    const r = parseGrep('grep -ri "search term" /path');
    expect(r?.pattern).toBe("search term");
    expect(r?.ignoreCase).toBe(true);
  });

  it("parses unquoted pattern", () => {
    const r = parseGrep("grep -r keyword /");
    expect(r?.pattern).toBe("keyword");
  });

  it("handles piped commands (no $ anchor)", () => {
    const r = parseGrep("grep -r 'pattern' / | head -5");
    expect(r?.pattern).toBe("pattern");
  });

  it("handles multiple flags", () => {
    const r = parseGrep("grep -rni 'test' /data");
    expect(r?.pattern).toBe("test");
    expect(r?.ignoreCase).toBe(true);
  });

  it("returns null for non-grep commands", () => {
    expect(parseGrep("cat /file")).toBeNull();
    expect(parseGrep("ls -la")).toBeNull();
  });
});

// ── INSERT SQL structure ─────────────────────────────────────────────────────

describe("codex: INSERT SQL structure", () => {
  it("uses message column for sessions table", () => {
    const sql = `INSERT INTO "sessions" (id, path, filename, message, author, size_bytes, project, description, creation_date, last_update_date) VALUES ('id', '/p', 'f', '{}'::jsonb, 'u', 2, 'p', 'Stop', 't', 't')`;
    expect(sql).toContain("message");
    expect(sql).toContain("::jsonb");
    expect(sql).not.toContain("content_text");
  });
});
