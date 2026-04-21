import { describe, expect, it } from "vitest";
import {
  buildMemoryEmbeddingText,
  buildSessionEmbeddingText,
  stableEmbeddingSourceHash,
} from "../../src/embeddings/text.js";

describe("embedding text builders", () => {
  it("builds a compact memory embedding payload", () => {
    const text = buildMemoryEmbeddingText({
      path: "/summaries/alice/session.md",
      filename: "session.md",
      project: "hivemind",
      description: "session summary",
      summary: "Discussed local embeddings and retrieval quality.",
    });

    expect(text).toContain("Path: /summaries/alice/session.md");
    expect(text).toContain("Project: hivemind");
    expect(text).toContain("Summary: Discussed local embeddings and retrieval quality.");
  });

  it("builds a session embedding payload from structured turn columns", () => {
    const text = buildSessionEmbeddingText({
      path: "/sessions/alice/demo.jsonl",
      event_type: "dialogue_turn",
      speaker: "user",
      text: "Can we run Harrier locally in TypeScript?",
      turn_summary: "Asked about local Harrier embeddings.",
      source_date_time: "2026-04-20T10:00:00Z",
      turn_index: 4,
    });

    expect(text).toContain("Event: dialogue_turn");
    expect(text).toContain("Speaker: user");
    expect(text).toContain("Text: Can we run Harrier locally in TypeScript?");
    expect(text).toContain("Turn summary: Asked about local Harrier embeddings.");
  });

  it("falls back to transcript extraction for session blobs", () => {
    const text = buildSessionEmbeddingText({
      path: "/sessions/alice/transcript.json",
      message: {
        date_time: "2026-04-20",
        turns: [
          { speaker: "user", text: "first turn" },
          { speaker: "assistant", text: "second turn" },
        ],
      },
    });

    expect(text).toContain("[user] first turn");
    expect(text).toContain("[assistant] second turn");
    expect(text).toContain("Date: 2026-04-20");
  });

  it("hashes identical embedding sources deterministically", () => {
    expect(stableEmbeddingSourceHash("same text")).toBe(stableEmbeddingSourceHash("same text"));
    expect(stableEmbeddingSourceHash("same text")).not.toBe(stableEmbeddingSourceHash("different text"));
  });
});
