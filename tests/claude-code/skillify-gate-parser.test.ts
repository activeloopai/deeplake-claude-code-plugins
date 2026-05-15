import { describe, expect, it } from "vitest";
import { extractJsonBlock, parseVerdict } from "../../src/skillify/gate-parser.js";

describe("extractJsonBlock", () => {
  it("returns null for empty / whitespace input", () => {
    expect(extractJsonBlock("")).toBeNull();
    expect(extractJsonBlock("   \n  ")).toBeNull();
  });

  it("returns null when there's no opening brace", () => {
    expect(extractJsonBlock("just prose, no JSON here")).toBeNull();
  });

  it("extracts a bare JSON object from stdout", () => {
    const out = extractJsonBlock(`{"verdict":"SKIP","reason":"x"}`);
    expect(out).toBe(`{"verdict":"SKIP","reason":"x"}`);
  });

  it("strips a ```json fence", () => {
    const text = '```json\n{"verdict":"KEEP","name":"a"}\n```';
    expect(extractJsonBlock(text)).toBe(`{"verdict":"KEEP","name":"a"}`);
  });

  it("strips a bare ``` fence (no json hint)", () => {
    const text = '```\n{"verdict":"SKIP","reason":"x"}\n```';
    expect(extractJsonBlock(text)).toBe(`{"verdict":"SKIP","reason":"x"}`);
  });

  it("ignores prose before / after a bare JSON object", () => {
    const text = `Sure, here's the verdict:\n{"verdict":"SKIP","reason":"y"}\nLet me know.`;
    expect(extractJsonBlock(text)).toBe(`{"verdict":"SKIP","reason":"y"}`);
  });

  it("balances nested braces correctly", () => {
    const text = `{"verdict":"KEEP","body":"## a {b} c"}`;
    expect(extractJsonBlock(text)).toBe(text);
  });
});

describe("parseVerdict", () => {
  it("parses a valid KEEP verdict", () => {
    const v = parseVerdict(`{"verdict":"KEEP","name":"x","body":"y","reason":"r"}`);
    expect(v).toEqual({ verdict: "KEEP", name: "x", body: "y", reason: "r" });
  });

  it("parses a valid SKIP verdict", () => {
    const v = parseVerdict(`{"verdict":"SKIP","reason":"already covered"}`);
    expect(v?.verdict).toBe("SKIP");
    expect(v?.reason).toBe("already covered");
  });

  it("parses a valid MERGE verdict from a fenced block", () => {
    const text = '```json\n{"verdict":"MERGE","name":"existing","body":"new body"}\n```';
    const v = parseVerdict(text);
    expect(v?.verdict).toBe("MERGE");
    expect(v?.name).toBe("existing");
  });

  it("returns null for malformed JSON", () => {
    expect(parseVerdict(`{not valid json at all`)).toBeNull();
  });

  it("returns null when verdict field is missing or invalid", () => {
    expect(parseVerdict(`{"name":"x"}`)).toBeNull();
    expect(parseVerdict(`{"verdict":"WHATEVER"}`)).toBeNull();
    expect(parseVerdict(`{"verdict":42}`)).toBeNull();
  });

  it("returns null for empty input (no JSON anywhere)", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("   ")).toBeNull();
    expect(parseVerdict("just text, no JSON")).toBeNull();
  });
});
