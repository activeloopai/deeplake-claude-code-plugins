import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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

function toolUseAssistantLine(toolUseId: string, command: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
    timestamp: "2026-05-13T10:01:00Z",
    sessionId: "real-session-id",
  };
}

function toolResultUserLine(toolUseId: string, content: unknown) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    timestamp: "2026-05-13T10:01:05Z",
  };
}

describe("parseTranscript — robustness", () => {
  it("returns zeros + fallback id when file does not exist", () => {
    const r = parseTranscript("/tmp/does-not-exist-hivemind-test.jsonl", "fb-xyz");
    expect(r.memorySearchCount).toBe(0);
    expect(r.memorySearchBytes).toBe(0);
    expect(r.sessionId).toBe("fb-xyz");
  });

  it("returns zeros when transcriptPath is empty string", () => {
    const r = parseTranscript("", "fb");
    expect(r.memorySearchBytes).toBe(0);
  });

  it("skips malformed JSON lines individually", () => {
    const path = join(TEMP_DIR, "transcript.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(toolUseAssistantLine("toolu_1", "grep -r 'x' ~/.deeplake/memory/")),
        "not-json",
        JSON.stringify(toolResultUserLine("toolu_1", "some result")),
      ].join("\n") + "\n",
      "utf-8",
    );
    const r = parseTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength("some result", "utf-8"));
  });

  it("falls back to `now` when no line carries a timestamp", () => {
    const path = writeTranscript([{ type: "user", message: { role: "user", content: [] } }]);
    const r = parseTranscript(path, "fb", new Date("2026-05-13T11:11:11Z"));
    expect(r.endedAt).toBe("2026-05-13T11:11:11.000Z");
  });

  it("falls back to fallbackSessionId when no line carries sessionId", () => {
    const path = writeTranscript([{ type: "user", message: { role: "user", content: [] }, timestamp: "2026-05-13T10:00:00Z" }]);
    expect(parseTranscript(path, "fb-xyz").sessionId).toBe("fb-xyz");
  });
});

describe("parseTranscript — memorySearchCount", () => {
  it("counts Bash tool calls that reference .deeplake/memory", () => {
    const path = writeTranscript([
      toolUseAssistantLine("toolu_1", "grep -r 'auth' ~/.deeplake/memory/summaries/"),
      toolUseAssistantLine("toolu_2", "cat ~/.deeplake/memory/index.md"),
      toolUseAssistantLine("toolu_3", "ls /tmp"), // not a memory lookup
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(2);
  });

  it("counts zero when no Bash command references the memory path", () => {
    const path = writeTranscript([
      toolUseAssistantLine("toolu_a", "git status"),
      toolUseAssistantLine("toolu_b", "npm test"),
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(0);
  });

  it("does not count non-Bash tool_use entries even if they mention memory", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/home/ubuntu/.deeplake/memory/index.md" } }],
        },
        timestamp: "2026-05-13T10:01:00Z",
      },
    ]);
    expect(parseTranscript(path, "fb").memorySearchCount).toBe(0);
  });
});

describe("parseTranscript — memorySearchBytes (bytes returned from memory lookups)", () => {
  it("sums string-form tool_result.content matched by tool_use_id", () => {
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
    expect(parseTranscript(path, "fb").memorySearchBytes).toBeGreaterThan(0);
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
