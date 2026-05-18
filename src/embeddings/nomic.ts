// Thin wrapper around @huggingface/transformers. Only loaded inside the daemon
// process — hooks never import this. Kept isolated so the heavyweight transformer
// dependency is not pulled into every bundled hook.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_DIMS,
  DEFAULT_DTYPE,
  DEFAULT_MODEL_REPO,
  DOC_PREFIX,
  QUERY_PREFIX,
  type EmbedKind,
} from "./protocol.js";

type Embedder = (input: string | string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>;

type TransformersModule = typeof import("@huggingface/transformers");
type TransformersImporter = () => Promise<TransformersModule>;

export interface NomicOptions {
  repo?: string;
  dtype?: string;
  dims?: number;
}

// ── transformers resolution ─────────────────────────────────────────────────
// The daemon may have been spawned from any plugin bundle path (marketplace
// versioned caches, dev tree, etc.). Bundle-relative `node_modules` resolution
// is unreliable across marketplace upgrades, so we explicitly look in the
// canonical shared-deps location that `hivemind embeddings install` populates,
// and only fall back to the bare specifier (dev tree / colocated install).

export async function _importFromCanonicalSharedDeps(
  sharedDir: string = join(homedir(), ".hivemind", "embed-deps"),
): Promise<TransformersModule> {
  const base = pathToFileURL(`${sharedDir}/`).href;
  // `createRequire(base).resolve(...)` honors the package's `"require"`
  // conditional export, which for @huggingface/transformers v3 points at
  // the CJS bundle (`./dist/transformers.node.cjs`). The dynamic
  // `import()` of a CJS file wraps it as `{ default: <exports> }`, so
  // top-level `env` / `pipeline` are not directly accessible. Normalize
  // both shapes (ESM .mjs would put names at the top level; CJS .cjs
  // hides them under `.default`).
  const absMain = createRequire(base).resolve("@huggingface/transformers");
  const mod = await import(pathToFileURL(absMain).href);
  return _normalizeTransformersModule(mod);
}

export async function _importFromBareSpecifier(): Promise<TransformersModule> {
  const mod = await import("@huggingface/transformers");
  return _normalizeTransformersModule(mod);
}

export function _normalizeTransformersModule(mod: unknown): TransformersModule {
  const m = mod as { default?: TransformersModule } & TransformersModule;
  if (m.default && typeof m.default === "object" && "pipeline" in m.default) {
    return m.default;
  }
  return m;
}

export async function defaultImportTransformers(
  canonical: () => Promise<TransformersModule> = _importFromCanonicalSharedDeps,
  bare: () => Promise<TransformersModule> = _importFromBareSpecifier,
): Promise<TransformersModule> {
  let canonicalErr: unknown;
  try {
    return await canonical();
  } catch (err) {
    canonicalErr = err;
  }
  try {
    return await bare();
  } catch (bareErr) {
    const detail = bareErr instanceof Error ? bareErr.message : String(bareErr);
    const canonicalDetail = canonicalErr instanceof Error ? canonicalErr.message : String(canonicalErr);
    throw new Error(
      `@huggingface/transformers is not installed anywhere reachable. ` +
        `Run \`hivemind embeddings install\` to install it. ` +
        `(canonical: ${canonicalDetail}; bare: ${detail})`,
    );
  }
}

// `defaultImportTransformers` has all-defaulted params, so calling it bare
// (`defaultImportTransformers()`) is fine — assign the function reference
// directly instead of wrapping in an arrow that v8 counts as a separate
// uncovered function.
let _importTransformers: TransformersImporter = defaultImportTransformers;

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
      const mod = await _importTransformers();
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

// ── Test helpers ────────────────────────────────────────────────────────────
// Production never calls these. They let unit tests bypass the
// canonical-shared-deps resolver (which would otherwise hit the real
// ~/.hivemind/embed-deps/ on dev machines and ignore vi.mock).

export function _setTransformersImporterForTesting(fn: TransformersImporter): void {
  _importTransformers = fn;
}

export function _resetTransformersImporterForTesting(): void {
  _importTransformers = defaultImportTransformers;
}
