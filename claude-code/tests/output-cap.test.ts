/**
 * Cap for large tool outputs (fix #5).
 *
 * Claude Code's Bash tool silently persists tool_result strings larger
 * than ~16 KB to disk and shows the model a 2 KB preview plus a path.
 * In the locomo baseline_cloud_100qa_fix123 run, 11 of 14 losing QAs
 * that hit this path never recovered the persisted file — the preview
 * was too small to carry the answer and the model gave up. `capOutput-
 * ForClaude` truncates at line boundaries below Claude Code's threshold
 * and replaces the tail with a footer that tells the model how to
 * refine the next call.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_OUTPUT_CAP_BYTES,
  capOutputForClaude,
} from "../../src/utils/output-cap.js";

describe("capOutputForClaude", () => {
  it("returns the input unchanged when it fits under the cap", () => {
    const short = "line1\nline2\nline3";
    expect(capOutputForClaude(short)).toBe(short);
  });

  it("is a no-op for an empty string and single short line", () => {
    expect(capOutputForClaude("")).toBe("");
    expect(capOutputForClaude("hello")).toBe("hello");
  });

  it("truncates at a line boundary once the input exceeds the cap", () => {
    const line = "x".repeat(100);
    const input = Array.from({ length: 200 }, (_, i) => `${i}:${line}`).join("\n");
    const out = capOutputForClaude(input, { kind: "grep" });

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CLAUDE_OUTPUT_CAP_BYTES);
    // Last surviving line must be whole — no dangling partial line before the footer.
    const body = out.split("\n... [")[0];
    expect(body.split("\n").every((l) => l.startsWith(""))).toBe(true);
    // Footer names the kind and reports elided line count / byte count.
    expect(out).toMatch(/\[grep truncated: \d+ more lines \([\d.]+ KB\) elided — refine with '\| head -N' or a tighter pattern\]/);
  });

  it("reports the correct number of elided lines in the footer", () => {
    const line = "x".repeat(100);
    const input = Array.from({ length: 500 }, () => line).join("\n");
    const out = capOutputForClaude(input, { kind: "cat" });

    const bodyLines = out.split("\n... [")[0].split("\n").length;
    const footerMatch = out.match(/(\d+) more lines/);
    expect(footerMatch).not.toBeNull();
    const elided = Number(footerMatch![1]);
    // Body + elided should account for all original lines.
    expect(bodyLines + elided).toBe(500);
  });

  it("handles a single oversized line by taking a byte prefix", () => {
    // One giant line — no newlines to cut on.
    const input = "a".repeat(CLAUDE_OUTPUT_CAP_BYTES * 3);
    const out = capOutputForClaude(input, { kind: "grep" });

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CLAUDE_OUTPUT_CAP_BYTES);
    expect(out).toContain("[grep truncated:");
    expect(out).toMatch(/[\d.]+ KB total/);
  });

  it("uses a custom maxBytes when provided", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line${i}:${"x".repeat(80)}`).join("\n");
    const out = capOutputForClaude(input, { maxBytes: 500, kind: "ls" });

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
    expect(out).toContain("[ls truncated:");
  });

  it("defaults the footer kind to 'output' when no kind is provided", () => {
    const input = "x".repeat(CLAUDE_OUTPUT_CAP_BYTES * 2);
    const out = capOutputForClaude(input);
    expect(out).toContain("[output truncated:");
  });

  it("produces output well under Claude Code's ~16 KB persist threshold", () => {
    const bigGrepLine = (i: number) =>
      `/sessions/conv_${i % 10}_session_${i}.json:[D${i}:1] Caroline: ${"x".repeat(160)}`;
    const input = Array.from({ length: 400 }, (_, i) => bigGrepLine(i)).join("\n");
    const inputSize = Buffer.byteLength(input, "utf8");
    expect(inputSize).toBeGreaterThan(16 * 1024); // confirm the fixture triggers truncation

    const out = capOutputForClaude(input, { kind: "grep" });
    // 2 KB preview was the painful case — we must give the model notably more
    // than that, but still fit comfortably below the 16 KB persist threshold.
    expect(Buffer.byteLength(out, "utf8")).toBeGreaterThan(4 * 1024);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(CLAUDE_OUTPUT_CAP_BYTES);
  });
});
