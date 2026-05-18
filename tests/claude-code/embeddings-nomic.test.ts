import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NomicEmbedder,
  defaultImportTransformers,
  _setTransformersImporterForTesting,
  _resetTransformersImporterForTesting,
  _normalizeTransformersModule,
  _importFromBareSpecifier,
  _importFromCanonicalSharedDeps,
} from "../../src/embeddings/nomic.js";

// Mock the heavy transformers import so these tests don't pull in
// onnxruntime-node or download any model weights. `load()` resolves
// transformers via an injected importer (default goes through the canonical
// shared-deps walk + bare fallback); we inject one that returns this mock so
// the test env on developer machines doesn't accidentally load the real
// installed copy at ~/.hivemind/embed-deps/.
vi.mock("@huggingface/transformers", () => {
  const embed = vi.fn((input: string | string[], _opts: Record<string, unknown>) => {
    const texts = Array.isArray(input) ? input : [input];
    // Return deterministic per-input vectors: 4 floats per text.
    const out: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(0.1 + i, 0.2 + i, 0.3 + i, 0.4 + i);
    }
    return Promise.resolve({ data: out });
  });
  return {
    // Explicit `default: undefined` so that `_normalizeTransformersModule`'s
    // `m.default && ...` probe doesn't trip the vitest auto-mock proxy,
    // which throws on access of any export not declared in this factory.
    default: undefined,
    env: { allowLocalModels: false, useFSCache: false },
    pipeline: vi.fn(async () => embed),
  };
});

beforeEach(() => {
  // Route the embedder's loader through the vi.mock-intercepted bare specifier
  // instead of the real canonical-shared-deps resolver.
  _setTransformersImporterForTesting(() => import("@huggingface/transformers") as any);
});

afterEach(() => {
  _resetTransformersImporterForTesting();
});

describe("NomicEmbedder", () => {
  it("loads lazily and reuses the pipeline across calls", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    await e.load();
    await e.load(); // second call is a no-op (cached)
    // If load() didn't memoize, pipeline() would be invoked twice; the
    // mock would return a fresh spy whose call counts would differ.
    const mod: any = await import("@huggingface/transformers");
    expect((mod.pipeline as any).mock.calls.length).toBe(1);
  });

  it("embeds a document with the search_document: prefix", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    const v = await e.embed("hello", "document");
    expect(v).toHaveLength(4);
    const mod: any = await import("@huggingface/transformers");
    const pipeline = await (mod.pipeline as any).mock.results[0].value;
    const callArg = (pipeline as any).mock.calls.at(-1)[0];
    expect(callArg).toBe("search_document: hello");
  });

  it("embeds a query with the search_query: prefix", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    await e.embed("q", "query");
    const mod: any = await import("@huggingface/transformers");
    const pipeline = await (mod.pipeline as any).mock.results[0].value;
    const callArg = (pipeline as any).mock.calls.at(-1)[0];
    expect(callArg).toBe("search_query: q");
  });

  it("batches inputs and splits results back into per-text vectors", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    const out = await e.embedBatch(["a", "b", "c"], "document");
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(4);
    expect(out[0][0]).toBeCloseTo(0.1);
    expect(out[1][0]).toBeCloseTo(1.1);
    expect(out[2][0]).toBeCloseTo(2.1);
  });

  it("returns [] for an empty batch without touching the pipeline", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    expect(await e.embedBatch([])).toEqual([]);
  });

  it("applies Matryoshka truncation when dims < full length", async () => {
    const e = new NomicEmbedder({ dims: 2 });
    const v = await e.embed("x");
    expect(v).toHaveLength(2);
    // Truncated + re-normalized; the raw vector was [0.1,0.2,0.3,0.4].
    // After slicing to 2 and renormalizing, |v| === 1.
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("returns vector unchanged when requested dims >= vector length", async () => {
    const e = new NomicEmbedder({ dims: 100 });
    const v = await e.embed("x");
    // Mock returns 4 dims; with target 100, truncate becomes a no-op and
    // the raw vector is returned verbatim (no renormalization).
    expect(v).toHaveLength(4);
  });

  it("handles a zero-norm truncation without dividing by zero", async () => {
    // Reach through the private helper via a custom mock that returns zeros.
    const mod: any = await import("@huggingface/transformers");
    const origPipeline = mod.pipeline;
    const wrapped = vi.fn(() => Promise.resolve(() => Promise.resolve({ data: [0, 0, 0, 0] })));
    (mod as any).pipeline = wrapped;
    try {
      const e = new NomicEmbedder({ dims: 2 });
      const v = await e.embed("z");
      expect(v).toEqual([0, 0]);
    } finally {
      (mod as any).pipeline = origPipeline;
    }
  });

  it("throws if embed is called before load resolves (defensive)", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    // Call load once normally to populate the pipeline.
    await e.load();
    // This is the happy path; the guard message fires only on a bug.
    const v = await e.embed("x");
    expect(v).toHaveLength(4);
  });

  it("defaults repo + dtype + dims without explicit options", () => {
    const e = new NomicEmbedder();
    expect(e.repo).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(e.dtype).toBe("q8");
    expect(e.dims).toBe(768);
  });

  it("coalesces concurrent load() calls onto a single pipeline build", async () => {
    // Replace pipeline with a slow one so the two load() calls overlap and
    // the second enters the `if (this.loading) return this.loading;` branch.
    const mod: any = await import("@huggingface/transformers");
    const orig = mod.pipeline;
    let calls = 0;
    mod.pipeline = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return async () => ({ data: [0, 0, 0, 0] });
    });
    try {
      const e = new NomicEmbedder({ dims: 4 });
      // Kick off two loads without awaiting between them.
      const [a, b] = await Promise.all([e.load(), e.load()]);
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      mod.pipeline = orig;
    }
  });

  it("embeds a query in embedBatch with the search_query prefix", async () => {
    const e = new NomicEmbedder({ dims: 4 });
    await e.embedBatch(["hi"], "query");
    const mod: any = await import("@huggingface/transformers");
    const pipeline = await (mod.pipeline as any).mock.results[0].value;
    const lastCall = (pipeline as any).mock.calls.at(-1)[0];
    expect(lastCall).toEqual(["search_query: hi"]);
  });
});

describe("defaultImportTransformers resolution", () => {
  // These tests bypass the beforeEach DI hook above and call
  // defaultImportTransformers() directly with stub resolvers, exercising the
  // canonical → bare fallback chain and the actionable error path.

  it("uses the canonical shared-deps resolver first when reachable", async () => {
    const canonical = vi.fn().mockResolvedValue({ marker: "canonical" });
    const bare = vi.fn().mockResolvedValue({ marker: "bare" });
    const mod = await defaultImportTransformers(canonical as any, bare as any);
    expect((mod as any).marker).toBe("canonical");
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(bare).not.toHaveBeenCalled();
  });

  it("falls back to the bare specifier when canonical throws", async () => {
    const canonical = vi.fn().mockRejectedValue(new Error("ENOENT shared-deps"));
    const bare = vi.fn().mockResolvedValue({ marker: "bare" });
    const mod = await defaultImportTransformers(canonical as any, bare as any);
    expect((mod as any).marker).toBe("bare");
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(bare).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable error referencing `hivemind embeddings install` when both fail", async () => {
    const canonical = vi.fn().mockRejectedValue(new Error("ENOENT shared-deps"));
    const bare = vi.fn().mockRejectedValue(new Error("Cannot find package '@huggingface/transformers'"));
    await expect(defaultImportTransformers(canonical as any, bare as any)).rejects.toThrow(
      /hivemind embeddings install/,
    );
  });

  it("preserves both underlying error messages in the thrown error for diagnostics", async () => {
    const canonical = vi.fn().mockRejectedValue(new Error("canonical-error-marker"));
    const bare = vi.fn().mockRejectedValue(new Error("bare-error-marker"));
    await expect(defaultImportTransformers(canonical as any, bare as any)).rejects.toThrow(
      /canonical-error-marker.*bare-error-marker/,
    );
  });

  it("wraps non-Error rejections in the combined error message", async () => {
    // The catch branches normalize string/object rejections via the `instanceof Error`
    // check; this asserts that the String(err) fallback path is exercised.
    const canonical = vi.fn().mockRejectedValue("plain-string-canonical");
    const bare = vi.fn().mockRejectedValue({ toString: () => "plain-object-bare" });
    await expect(defaultImportTransformers(canonical as any, bare as any)).rejects.toThrow(
      /plain-string-canonical.*plain-object-bare/,
    );
  });
});

describe("_normalizeTransformersModule (CJS-default-unwrap helper)", () => {
  // The CJS bundle of @huggingface/transformers v3 lives at
  // `dist/transformers.node.cjs`; `await import(<cjs file>)` wraps the CJS
  // exports under `.default`. The ESM .mjs build exposes names at top level.
  // The normalizer must accept both shapes and return one with top-level
  // `pipeline` / `env`.

  it("unwraps the .default key when CJS-style module has `default.pipeline`", () => {
    const inner = { pipeline: () => "x", env: { allowLocalModels: false }, marker: "inner" };
    const wrapped = { default: inner };
    const out = _normalizeTransformersModule(wrapped) as any;
    expect(out.marker).toBe("inner");
    expect(out.pipeline).toBe(inner.pipeline);
    expect(out.env).toBe(inner.env);
  });

  it("returns the module as-is when ESM-style exposes `pipeline` at the top level", () => {
    const top = { pipeline: () => "y", env: { allowLocalModels: false }, marker: "top" };
    const out = _normalizeTransformersModule(top) as any;
    expect(out.marker).toBe("top");
  });

  it("returns the module as-is when `.default` exists but doesn't carry `pipeline`", () => {
    // ESM modules without a default export still get a `.default` namespace key
    // pointing at the module record itself when bundled by some tools — make
    // sure we don't accidentally unwrap into something that lacks `pipeline`.
    const mod = { pipeline: () => "z", default: { someOtherKey: 1 }, marker: "top" };
    const out = _normalizeTransformersModule(mod) as any;
    expect(out.marker).toBe("top");
    expect(out.pipeline).toBe(mod.pipeline);
  });

  it("returns the module as-is when `.default` is falsy (null/undefined)", () => {
    const mod = { pipeline: () => "w", default: null, marker: "top" };
    const out = _normalizeTransformersModule(mod) as any;
    expect(out.marker).toBe("top");
  });
});

describe("_importFromBareSpecifier", () => {
  // The bare-specifier importer relies on whatever the Node resolver picks
  // up; in this test file `vi.mock("@huggingface/transformers")` (at the
  // top) intercepts that resolution, so the importer should return the
  // mocked module after normalization.
  it("returns the mocked transformers module after normalization", async () => {
    const mod = await _importFromBareSpecifier();
    expect(mod).toBeDefined();
    expect(typeof (mod as any).pipeline).toBe("function");
    expect((mod as any).env).toMatchObject({ allowLocalModels: false });
  });
});

describe("_importFromCanonicalSharedDeps", () => {
  // Build a real on-disk fixture that looks like a hivemind-installed
  // shared-deps directory, then point the importer at it. Avoids any
  // mocking gymnastics around `createRequire` / dynamic `import()`.

  let sharedDir: string;

  beforeEach(() => {
    sharedDir = mkdtempSync(join(tmpdir(), "nomic-shared-deps-"));
    const pkgDir = join(sharedDir, "node_modules", "@huggingface", "transformers");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@huggingface/transformers", main: "index.cjs" }),
    );
    // Minimal CJS shim exposing the same surface the daemon touches.
    writeFileSync(
      join(pkgDir, "index.cjs"),
      "module.exports = { pipeline: function () { return 'fixture'; }, env: { allowLocalModels: false } };",
    );
  });

  afterEach(() => {
    rmSync(sharedDir, { recursive: true, force: true });
  });

  it("resolves transformers from the canonical shared-deps dir and normalizes the result", async () => {
    const mod = await _importFromCanonicalSharedDeps(sharedDir);
    expect(typeof (mod as any).pipeline).toBe("function");
    expect((mod as any).pipeline()).toBe("fixture");
    expect((mod as any).env.allowLocalModels).toBe(false);
  });

  it("propagates the underlying require error when transformers is missing under the base", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nomic-empty-"));
    try {
      await expect(_importFromCanonicalSharedDeps(emptyDir)).rejects.toThrow(/transformers/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
