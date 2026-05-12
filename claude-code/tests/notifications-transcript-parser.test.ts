import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countHivemindEmittedBytes,
  isMemoryLookupCommand,
  parseTranscript,
} from "../../src/notifications/transcript-parser.js";

let TEMP_DIR = "";

beforeEach(() => {
  TEMP_DIR = mkdtempSync(join(tmpdir(), "hivemind-transcript-test-"));
});

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function writeTranscript(lines: object[]): string {
  const file = join(TEMP_DIR, "transcript.jsonl");
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

const SAMPLE_USER_LINE = {
  type: "user",
  message: { role: "user", content: "hello" },
  timestamp: "2026-05-08T10:00:00Z",
  sessionId: "real-session-id",
};

function assistantLine(usage: Record<string, number>, model = "claude-opus-4-7", timestamp = "2026-05-08T10:01:00Z") {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model,
      type: "message",
      content: [{ type: "text", text: "hi" }],
      usage,
    },
    timestamp,
    sessionId: "real-session-id",
  };
}

describe("parseTranscript — happy path", () => {
  it("sums usage across multiple assistant turns", () => {
    const path = writeTranscript([
      SAMPLE_USER_LINE,
      assistantLine({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
      assistantLine({ input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 200, cache_creation_input_tokens: 60 }),
    ]);
    const r = parseTranscript(path, "fallback-id");
    expect(r.inputTokens).toBe(30);
    expect(r.outputTokens).toBe(13);
    expect(r.cacheReadTokens).toBe(300);
    expect(r.cacheCreationTokens).toBe(110);
    expect(r.assistantTurns).toBe(2);
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.sessionId).toBe("real-session-id");
  });

  it("uses the last seen timestamp as endedAt", () => {
    const path = writeTranscript([
      assistantLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "claude-opus-4-7", "2026-05-07T09:00:00Z"),
      assistantLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "claude-opus-4-7", "2026-05-08T10:00:00Z"),
    ]);
    const r = parseTranscript(path, "fb");
    expect(r.endedAt).toBe("2026-05-08T10:00:00Z");
  });

  it("uses the first non-empty assistant model and ignores subsequent ones", () => {
    const path = writeTranscript([
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "claude-opus-4-7"),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "claude-sonnet-4-6"),
    ]);
    expect(parseTranscript(path, "fb").model).toBe("claude-opus-4-7");
  });
});

describe("parseTranscript — robustness", () => {
  it("returns zeros + fallback id when file does not exist", () => {
    const r = parseTranscript("/tmp/does-not-exist-hivemind-test.jsonl", "fallback-xyz");
    expect(r.assistantTurns).toBe(0);
    expect(r.inputTokens).toBe(0);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.sessionId).toBe("fallback-xyz");
  });

  it("returns zeros when transcriptPath is empty string", () => {
    const r = parseTranscript("", "fallback-xyz");
    expect(r.assistantTurns).toBe(0);
    expect(r.sessionId).toBe("fallback-xyz");
  });

  it("ignores user, system, attachment, and tool_result lines", () => {
    const path = writeTranscript([
      SAMPLE_USER_LINE,
      { type: "system", content: "x" },
      { type: "attachment", attachment: { type: "hook_success" } },
      { type: "user", message: { role: "user" }, toolUseResult: { stdout: "y" } },
      assistantLine({ input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    const r = parseTranscript(path, "fb");
    expect(r.assistantTurns).toBe(1);
    expect(r.inputTokens).toBe(5);
  });

  it("skips malformed JSON lines individually", () => {
    const path = join(TEMP_DIR, "transcript.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(assistantLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })),
        "not-json",
        JSON.stringify(assistantLine({ input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })),
      ].join("\n") + "\n",
      "utf-8",
    );
    const r = parseTranscript(path, "fb");
    expect(r.assistantTurns).toBe(2);
    expect(r.inputTokens).toBe(3);
  });

  it("treats missing usage fields as 0", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-4-7", usage: {} },
        timestamp: "2026-05-08T10:00:00Z",
      },
    ]);
    const r = parseTranscript(path, "fb");
    expect(r.assistantTurns).toBe(1);
    expect(r.inputTokens).toBe(0);
    expect(r.cacheReadTokens).toBe(0);
  });

  it("treats negative or non-numeric usage values as 0 (defensive against weird transcripts)", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: -5, output_tokens: "ten", cache_read_input_tokens: null, cache_creation_input_tokens: 100 },
        },
        timestamp: "2026-05-08T10:00:00Z",
      },
    ]);
    const r = parseTranscript(path, "fb");
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheCreationTokens).toBe(100);
  });

  it("falls back to `now` when no line carries a timestamp", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: {
          role: "assistant",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);
    const fixedNow = new Date("2026-05-08T11:11:11Z");
    const r = parseTranscript(path, "fb", fixedNow);
    expect(r.endedAt).toBe("2026-05-08T11:11:11.000Z");
  });

  it("falls back to fallbackSessionId when no line carries sessionId", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: { role: "assistant", usage: { input_tokens: 1, output_tokens: 1 } },
        timestamp: "2026-05-08T10:00:00Z",
      },
    ]);
    expect(parseTranscript(path, "fb-xyz").sessionId).toBe("fb-xyz");
  });
});

describe("parseTranscript — hivemindInjectedBytes", () => {
  function hivemindHookLine(stdout: string, command = 'node "/home/ubuntu/.claude/plugins/hivemind/bundle/session-start.js"') {
    return {
      type: "attachment",
      attachment: {
        type: "hook_success",
        hookEvent: "SessionStart",
        hookName: "SessionStart:startup",
        command,
        stdout,
        durationMs: 1234,
      },
      timestamp: "2026-05-08T10:00:00Z",
    };
  }

  it("counts bytes of additionalContext from a hivemind SessionStart hook attachment", () => {
    const additional = "DEEPLAKE MEMORY: example payload of 50 chars for test";
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: additional } });
    const path = writeTranscript([hivemindHookLine(stdout), assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(Buffer.byteLength(additional, "utf-8"));
  });

  it("also counts top-level systemMessage bytes (notifications channel)", () => {
    const sys = "🐝 Hivemind weekly — banner text";
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" }, systemMessage: sys });
    const path = writeTranscript([
      hivemindHookLine(stdout, 'node "/home/ubuntu/.claude/plugins/hivemind/bundle/session-notifications.js"'),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(Buffer.byteLength(sys, "utf-8"));
  });

  it("sums injected bytes across multiple hivemind hooks in the same session", () => {
    const a = "AAA";
    const b = "BBBBB";
    const path = writeTranscript([
      hivemindHookLine(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: a } })),
      hivemindHookLine(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: b } }), 'node "/home/ubuntu/.claude/plugins/hivemind/bundle/session-notifications.js"'),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(Buffer.byteLength(a + b, "utf-8"));
  });

  it("ignores SessionStart attachments from other plugins / non-hivemind paths", () => {
    const path = writeTranscript([
      hivemindHookLine(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ignored-other-plugin" } }),
        'node "/home/ubuntu/.claude/plugins/some-other-plugin/bundle/session-start.js"',
      ),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(0);
  });

  it("ignores non-SessionStart hook attachments even from the hivemind path", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "tool reminder" } });
    const path = writeTranscript([
      {
        type: "attachment",
        attachment: {
          type: "hook_success",
          hookEvent: "PreToolUse",
          command: 'node "/home/ubuntu/.claude/plugins/hivemind/bundle/pre-tool-use.js"',
          stdout,
        },
        timestamp: "2026-05-08T10:00:00Z",
      },
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(0);
  });

  it("returns 0 when the attachment stdout is not parseable JSON", () => {
    const path = writeTranscript([
      hivemindHookLine("not-json"),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(parseTranscript(path, "fb").hivemindInjectedBytes).toBe(0);
  });
});

describe("parseTranscript — memorySearchCount", () => {
  function bashToolUseLine(command: string) {
    return {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "tool_use", name: "Bash", input: { command } }],
      },
      timestamp: "2026-05-08T10:01:00Z",
    };
  }

  it("counts Bash tool calls that reference .deeplake/memory", () => {
    const path = writeTranscript([
      bashToolUseLine("grep -r 'auth' ~/.deeplake/memory/summaries/"),
      bashToolUseLine("cat ~/.deeplake/memory/index.md"),
      bashToolUseLine("ls /tmp"), // not a memory lookup
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(2);
  });

  it("counts zero when no Bash command references the memory path", () => {
    const path = writeTranscript([
      bashToolUseLine("git status"),
      bashToolUseLine("npm test"),
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(0);
  });

  it("does not count non-Bash tool_use entries even if they mention memory", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/home/ubuntu/.deeplake/memory/index.md" } }],
        },
        timestamp: "2026-05-08T10:01:00Z",
      },
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(0);
  });
});

describe("countHivemindEmittedBytes (helper)", () => {
  it("sums additionalContext + systemMessage bytes", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { additionalContext: "abc" },
      systemMessage: "de",
    });
    expect(countHivemindEmittedBytes(out)).toBe(5);
  });
  it("returns 0 for non-JSON input", () => {
    expect(countHivemindEmittedBytes("not-json")).toBe(0);
  });
  it("returns 0 when neither field is a string", () => {
    expect(countHivemindEmittedBytes(JSON.stringify({ hookSpecificOutput: {}, systemMessage: 42 }))).toBe(0);
  });
});

describe("isMemoryLookupCommand (helper)", () => {
  it("matches commands that reference .deeplake/memory", () => {
    expect(isMemoryLookupCommand("grep -r foo ~/.deeplake/memory/summaries")).toBe(true);
    expect(isMemoryLookupCommand("cat /home/x/.deeplake/memory/index.md")).toBe(true);
  });
  it("does not match unrelated commands", () => {
    expect(isMemoryLookupCommand("ls /tmp")).toBe(false);
    expect(isMemoryLookupCommand("grep deeplake ~/.config")).toBe(false);
  });
});

describe("parseTranscript — memorySearchBytes (bytes returned from memory lookups)", () => {
  function toolUseAssistantLine(toolUseId: string, command: string) {
    return {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
      },
      timestamp: "2026-05-08T10:01:00Z",
    };
  }
  function toolResultUserLine(toolUseId: string, content: unknown) {
    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
      },
      timestamp: "2026-05-08T10:01:05Z",
    };
  }

  it("sums bytes of tool_result.content (string form) matched to a memory-lookup tool_use_id", () => {
    const result = "match1\nmatch2\nmatch3";
    const path = writeTranscript([
      toolUseAssistantLine("toolu_xyz", "grep -r 'foo' ~/.deeplake/memory/summaries"),
      toolResultUserLine("toolu_xyz", result),
    ]);
    expect(parseTranscript(path, "fb").memorySearchBytes).toBe(Buffer.byteLength(result, "utf-8"));
  });

  it("supports tool_result content as an array of {type,text} parts", () => {
    const t1 = "abc";
    const t2 = "defgh";
    const path = writeTranscript([
      toolUseAssistantLine("toolu_a", "cat ~/.deeplake/memory/index.md"),
      toolResultUserLine("toolu_a", [{ type: "text", text: t1 }, { type: "text", text: t2 }]),
    ]);
    expect(parseTranscript(path, "fb").memorySearchBytes).toBe(Buffer.byteLength(t1 + t2, "utf-8"));
  });

  it("ignores tool_result entries whose tool_use_id was NOT a memory lookup", () => {
    const path = writeTranscript([
      toolUseAssistantLine("toolu_unrelated", "ls /tmp"),
      toolResultUserLine("toolu_unrelated", "file1\nfile2\n"),
    ]);
    expect(parseTranscript(path, "fb").memorySearchBytes).toBe(0);
  });

  it("sums across multiple memory-lookup pairs in the same session", () => {
    const r1 = "x".repeat(100);
    const r2 = "y".repeat(250);
    const path = writeTranscript([
      toolUseAssistantLine("toolu_1", "grep -r foo ~/.deeplake/memory/"),
      toolResultUserLine("toolu_1", r1),
      toolUseAssistantLine("toolu_2", "cat ~/.deeplake/memory/notes/x.md"),
      toolResultUserLine("toolu_2", r2),
    ]);
    expect(parseTranscript(path, "fb").memorySearchBytes).toBe(350);
  });

  it("returns 0 when tool_use precedes tool_result with no match (orphan use)", () => {
    const path = writeTranscript([
      toolUseAssistantLine("toolu_orphan", "grep -r foo ~/.deeplake/memory/"),
      // no tool_result line
    ]);
    expect(parseTranscript(path, "fb").memorySearchBytes).toBe(0);
  });

  it("handles tool_result content of unexpected shape without throwing", () => {
    const path = writeTranscript([
      toolUseAssistantLine("toolu_w", "cat ~/.deeplake/memory/index.md"),
      toolResultUserLine("toolu_w", { weird: "shape", n: 42 }),
    ]);
    expect(() => parseTranscript(path, "fb")).not.toThrow();
    // JSON-stringified fallback length is > 0
    expect(parseTranscript(path, "fb").memorySearchBytes).toBeGreaterThan(0);
  });
});
