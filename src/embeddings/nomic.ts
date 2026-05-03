// Thin wrapper around @huggingface/transformers. Only loaded inside the daemon
// process — hooks never import this. Kept isolated so the heavyweight transformer
// dependency is not pulled into every bundled hook.

import {
  DEFAULT_DIMS,
  DEFAULT_DTYPE,
  DEFAULT_MODEL_REPO,
  DOC_PREFIX,
  QUERY_PREFIX,
  type EmbedKind,
} from "./protocol.js";

type Embedder = (input: string | string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>;

export interface NomicOptions {
  repo?: string;
  dtype?: string;
  dims?: number;
}

export class NomicEmbedder {
  private pipeline: Embedder | null = null;
  private loading: Promise<void> | null = null;
  readonly repo: string;
  readonly dtype: string;
  readonly dims: number;

  constructor(opts: NomicOptions = {}) {
    this.repo = opts.repo ?? DEFAULT_MODEL_REPO;
    this.dtype = opts.dtype ?? DEFAULT_DTYPE;
    this.dims = opts.dims ?? DEFAULT_DIMS;
  }

  async load(): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import("@huggingface/transformers");
      mod.env.allowLocalModels = false;
      mod.env.useFSCache = true;
      this.pipeline = (await mod.pipeline("feature-extraction", this.repo, { dtype: this.dtype as "fp32" | "q8" })) as unknown as Embedder;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private addPrefix(text: string, kind: EmbedKind): string {
    return (kind === "query" ? QUERY_PREFIX : DOC_PREFIX) + text;
  }

  async embed(text: string, kind: EmbedKind = "document"): Promise<number[]> {
    await this.load();
    if (!this.pipeline) throw new Error("embedder not loaded");
    const out = await this.pipeline(this.addPrefix(text, kind), { pooling: "mean", normalize: true });
    const full = Array.from(out.data as ArrayLike<number>);
    return this.truncate(full);
  }

  async embedBatch(texts: string[], kind: EmbedKind = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.load();
    if (!this.pipeline) throw new Error("embedder not loaded");
    const prefixed = texts.map(t => this.addPrefix(t, kind));
    const out = await this.pipeline(prefixed, { pooling: "mean", normalize: true });
    const flat = Array.from(out.data as ArrayLike<number>);
    const total = flat.length;
    const full = total / texts.length;
    const batches: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      batches.push(this.truncate(flat.slice(i * full, (i + 1) * full)));
    }
    return batches;
  }

  private truncate(vec: number[]): number[] {
    if (this.dims >= vec.length) return vec;
    // Matryoshka: truncate then re-normalize.
    const head = vec.slice(0, this.dims);
    let norm = 0;
    for (const v of head) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return head;
    for (let i = 0; i < head.length; i++) head[i] /= norm;
    return head;
  }
}
