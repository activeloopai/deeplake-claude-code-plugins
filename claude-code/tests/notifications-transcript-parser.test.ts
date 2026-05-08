import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTranscript } from "../../src/notifications/transcript-parser.js";

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
