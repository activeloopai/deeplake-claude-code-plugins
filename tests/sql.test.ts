import { describe, it, expect } from "vitest";
import { sqlStr, sqlLike, sqlIdent } from "../src/utils/sql.js";

describe("sqlStr", () => {
  it("escapes single quotes", () => {
    expect(sqlStr("it's")).toBe("it''s");
  });
  it("escapes backslashes", () => {
    expect(sqlStr("a\\b")).toBe("a\\\\b");
  });
  it("strips NUL bytes", () => {
    expect(sqlStr("a\0b")).toBe("ab");
  });
  it("strips control characters", () => {
    expect(sqlStr("a\x01b\x7fc")).toBe("abc");
  });
  it("passes normal strings through", () => {
    expect(sqlStr("hello world")).toBe("hello world");
  });
  it("handles combined escapes", () => {
    expect(sqlStr("it's a\\path\0")).toBe("it''s a\\\\path");
  });
});

describe("sqlLike", () => {
  it("escapes % wildcard", () => {
    expect(sqlLike("100%")).toBe("100\\%");
  });
  it("escapes _ wildcard", () => {
    expect(sqlLike("a_b")).toBe("a\\_b");
  });
  it("also escapes single quotes", () => {
    expect(sqlLike("it's 50%")).toBe("it''s 50\\%");
  });
});

describe("sqlIdent", () => {
  it("returns valid identifier", () => {
    expect(sqlIdent("my_table")).toBe("my_table");
  });
  it("allows leading underscore", () => {
    expect(sqlIdent("_private")).toBe("_private");
  });
  it("throws on invalid identifier with spaces", () => {
    expect(() => sqlIdent("my table")).toThrow("Invalid SQL identifier");
  });
  it("throws on identifier starting with number", () => {
    expect(() => sqlIdent("1table")).toThrow("Invalid SQL identifier");
  });
  it("throws on empty string", () => {
    expect(() => sqlIdent("")).toThrow("Invalid SQL identifier");
  });
  it("throws on special characters", () => {
    expect(() => sqlIdent("drop;--")).toThrow("Invalid SQL identifier");
  });
});
