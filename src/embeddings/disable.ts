import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Master opt-out for the embedding feature.
 *
 * Embeddings are off when EITHER:
 *
 * 1. `HIVEMIND_EMBEDDINGS=false` is set — explicit opt-out for air-gapped /
 *    no-network installs, CI / benchmarks that want pure-lexical retrieval,
 *    and users who don't want the ~110 MB nomic download.
 *
 * 2. `@huggingface/transformers` is not resolvable from this bundle — the
 *    plugin ships without it (it has native deps that can't be bundled into
 *    the daemon). A fresh marketplace install lacks it; the README documents
 *    the optional `npm install @huggingface/transformers` step. When absent,
 *    we degrade silently to lexical-only mode rather than spawning a daemon
 *    that will crash on `import("@huggingface/transformers")` and emit
 *    confusing logs.
 *
 * In either case: SessionStart skips the warmup, capture / wiki-worker write
 * rows with NULL in the embedding column, and `Grep` falls back to BM25 /
 * ILIKE matching on text columns. Existing rows' embeddings remain readable.
 *
 * Read-once: cached for the lifetime of the (short-lived) hook process so a
 * live `export HIVEMIND_EMBEDDINGS=...` takes effect on the next session.
 */

export type EmbeddingsStatus = "enabled" | "env-disabled" | "no-transformers";

let cachedStatus: EmbeddingsStatus | null = null;

function defaultResolveTransformers(): void {
  // Resolve from this module's location — the same node_modules walk Node
  // would do for the spawned daemon, since the daemon lives in the same
  // bundle dir tree (true for CC/codex/cursor/hermes which symlink their
  // plugin's node_modules to the shared deps).
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return;
  } catch { /* fall through */ }
  // Fall back to the canonical shared deps location. Pi (and any future
  // agent that doesn't ship a per-agent bundle adjacent to a node_modules)
  // lands here: the shared deps at ~/.hivemind/embed-deps/node_modules
  // are populated by `hivemind embeddings install`, and the daemon spawn
  // resolves transformers via that exact dir.
  const sharedDir = join(homedir(), ".hivemind", "embed-deps");
  createRequire(pathToFileURL(`${sharedDir}/`).href).resolve("@huggingface/transformers");
}

let _resolve: () => void = defaultResolveTransformers;

function detectStatus(): EmbeddingsStatus {
  if (process.env.HIVEMIND_EMBEDDINGS === "false") return "env-disabled";
  try {
    _resolve();
    return "enabled";
  } catch {
    return "no-transformers";
  }
}

export function embeddingsStatus(): EmbeddingsStatus {
  if (cachedStatus !== null) return cachedStatus;
  cachedStatus = detectStatus();
  return cachedStatus;
}

export function embeddingsDisabled(): boolean {
  return embeddingsStatus() !== "enabled";
}

// ── Test helpers ────────────────────────────────────────────────────────────
// Exposed so unit tests can simulate "transformers not installed" without
// actually uninstalling the package. Underscore-prefixed and intentionally
// not re-exported from any public entry point — runtime never calls these.

export function _setResolveForTesting(fn: () => void): void {
  _resolve = fn;
  cachedStatus = null;
}

export function _resetForTesting(): void {
  _resolve = defaultResolveTransformers;
  cachedStatus = null;
}
