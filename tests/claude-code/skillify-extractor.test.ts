import { describe, it, expect } from "vitest";
import { extractPairs, type SessionRow } from "../../src/skillify/extractors/index.js";

describe("extractPairs", () => {
  it("pairs a single user prompt with the immediately following assistant message", () => {
    const rows: SessionRow[] = [
      { type: "user_message", content: "what is the time", session_id: "s1", agent: "claude_code", creation_date: "2026-05-06T00:00:01Z" },
      { type: "assistant_message", content: "I can check.", creation_date: "2026-05-06T00:00:02Z" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sessionId: "s1",
      agent: "claude_code",
      prompt: "what is the time",
      answer: "I can check.",
    });
  });

  it("drops tool_call rows entirely", () => {
    const rows: SessionRow[] = [
      { type: "user_message", content: "do the thing" },
      { type: "tool_call", content: "{\"path\":\"/x\"}" } as any,
      { type: "assistant_message", content: "done." },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe("done.");
  });

  it("concatenates multiple assistant messages between two prompts into one answer", () => {
    const rows: SessionRow[] = [
      { type: "user_message", content: "two-step" },
      { type: "assistant_message", content: "first part" },
      { type: "tool_call", content: "ignored" } as any,
      { type: "assistant_message", content: "second part" },
      { type: "user_message", content: "next prompt" },
      { type: "assistant_message", content: "next answer" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].answer).toBe("first part\n\nsecond part");
    expect(pairs[1].prompt).toBe("next prompt");
    expect(pairs[1].answer).toBe("next answer");
  });

  it("does not emit a pair for an in-flight prompt with no answer yet", () => {
    const rows: SessionRow[] = [
      { type: "user_message", content: "answered prompt" },
      { type: "assistant_message", content: "answer" },
      { type: "user_message", content: "in-flight prompt with no response" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].prompt).toBe("answered prompt");
  });

  it("drops stray assistant messages with no preceding prompt", () => {
    const rows: SessionRow[] = [
      { type: "assistant_message", content: "stray welcome message" },
      { type: "user_message", content: "hi" },
      { type: "assistant_message", content: "hello" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].prompt).toBe("hi");
    expect(pairs[0].answer).toBe("hello");
  });

  it("ignores empty assistant content blocks but keeps non-empty ones", () => {
    const rows: SessionRow[] = [
      { type: "user_message", content: "prompt" },
      { type: "assistant_message", content: "   " },
      { type: "assistant_message", content: "real answer" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe("real answer");
  });

  it("preserves session_id, agent, and date from the user_message row", () => {
    const rows: SessionRow[] = [
      {
        type: "user_message",
        content: "p",
        session_id: "abc-123",
        agent: "codex",
        creation_date: "2026-05-06T10:00:00Z",
      },
      { type: "assistant_message", content: "a" },
    ];
    const pairs = extractPairs(rows);
    expect(pairs[0].sessionId).toBe("abc-123");
    expect(pairs[0].agent).toBe("codex");
    expect(pairs[0].date).toBe("2026-05-06T10:00:00Z");
  });

  it("returns [] for empty input", () => {
    expect(extractPairs([])).toEqual([]);
  });

  it("returns [] when only tool_calls are present", () => {
    const rows: SessionRow[] = [
      { type: "tool_call", content: "x" } as any,
      { type: "tool_call", content: "y" } as any,
    ];
    expect(extractPairs(rows)).toEqual([]);
  });
});
