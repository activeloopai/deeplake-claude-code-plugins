import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { embeddingsDisabled } from "../../src/embeddings/disable.js";

describe("embeddingsDisabled()", () => {
  const original = process.env.HIVEMIND_EMBEDDINGS;

  beforeEach(() => {
    delete process.env.HIVEMIND_EMBEDDINGS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HIVEMIND_EMBEDDINGS;
    else process.env.HIVEMIND_EMBEDDINGS = original;
  });

  it("returns false when the env var is unset (default behaviour)", () => {
    expect(embeddingsDisabled()).toBe(false);
  });

  it("returns true only when explicitly set to the string 'false'", () => {
    process.env.HIVEMIND_EMBEDDINGS = "false";
    expect(embeddingsDisabled()).toBe(true);
  });

  it("stays off for any non-'false' truthy value (intentional: avoid surprise kills)", () => {
    process.env.HIVEMIND_EMBEDDINGS = "0";
    expect(embeddingsDisabled()).toBe(false);

    process.env.HIVEMIND_EMBEDDINGS = "no";
    expect(embeddingsDisabled()).toBe(false);

    process.env.HIVEMIND_EMBEDDINGS = "true";
    expect(embeddingsDisabled()).toBe(false);

    process.env.HIVEMIND_EMBEDDINGS = "";
    expect(embeddingsDisabled()).toBe(false);
  });
});
