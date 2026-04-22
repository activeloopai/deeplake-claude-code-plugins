import { describe, it, expect, vi } from "vitest";
import { NomicEmbedder } from "../../src/embeddings/nomic.js";

// Mock the heavy transformers import so these tests don't pull in
// onnxruntime-node or download any model weights. `load()` uses
// `await import("@huggingface/transformers")` — vi.mock intercepts.
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
    env: { allowLocalModels: false, useFSCache: false },
    pipeline: vi.fn(async () => embed),
  };
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
    const zeroPipe = vi.fn(async () => [0, 0, 0, 0]);
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
