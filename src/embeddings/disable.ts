import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getEmbeddingsEnabled } from "../user-config.js";

/**
 * Master opt-out for the embedding feature.
 *
 * Embeddings are off when EITHER:
 *
 * 1. The user has opted out via `~/.deeplake/config.json` →
 *    `embeddings.enabled: false`. Set by `hivemind embeddings disable` or
 *    `hivemind embeddings uninstall`, or by the one-shot migration that
 *    seeds the config from `HIVEMIND_EMBEDDINGS` on first run.
 *
 * 2. `@huggingface/transformers` is not resolvable — the plugin ships
 *    without it (native deps can't be bundled). A fresh marketplace install
 *    lacks it until the user runs `hivemind embeddings install`. When
 *    absent, we degrade silently to lexical-only mode rather than spawning
 *    a daemon that will crash on import.
 *
 * In either case: SessionStart skips the warmup, capture / wiki-worker
 * write rows with NULL in the embedding column, and `Grep` falls back to
 * BM25 / ILIKE matching on text columns. Existing rows' embeddings remain
 * readable.
 *
 * Read-once: the status is cached for the lifetime of the (short-lived)
 * hook process. `hivemind embeddings enable|disable` takes effect on the
 * next session, after the daemon is recycled.
 */

export type EmbeddingsStatus = "enabled" | "user-disabled" | "no-transformers";

let cachedStatus: EmbeddingsStatus | null = null;

function defaultResolveTransformers(): void {
  // Try the canonical shared-deps location first — this is the location
  // `hivemind embeddings install` populates, and the location the daemon
  // resolves from in production. Probing here matches what will actually
  // be loaded at runtime, eliminating the previous probe/use asymmetry
  // (probe said enabled, daemon then failed with MODULE_NOT_FOUND).
  const sharedDir = join(homedir(), ".hivemind", "embed-deps");
  try {
    createRequire(pathToFileURL(`${sharedDir}/`).href).resolve("@huggingface/transformers");
    return;
  } catch { /* fall through */ }
  // Bundle-relative walk for the dev tree or any future install layout
  // that colocates `node_modules` next to the running file.
  createRequire(import.meta.url).resolve("@huggingface/transformers");
}

let _resolve: () => void = defaultResolveTransformers;
let _readEnabled: () => boolean = getEmbeddingsEnabled;

function detectStatus(): EmbeddingsStatus {
  if (!_readEnabled()) return "user-disabled";
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
// Exposed so unit tests can simulate "transformers not installed" or
// "user opted out" without touching real env or disk. Underscore-prefixed
// and intentionally not re-exported from any public entry point.

export function _setResolveForTesting(fn: () => void): void {
  _resolve = fn;
  cachedStatus = null;
}

export function _setEnabledReaderForTesting(fn: () => boolean): void {
  _readEnabled = fn;
  cachedStatus = null;
}

export function _resetForTesting(): void {
  _resolve = defaultResolveTransformers;
  _readEnabled = getEmbeddingsEnabled;
  cachedStatus = null;
}
