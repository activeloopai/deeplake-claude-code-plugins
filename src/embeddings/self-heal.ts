// Self-heal the per-plugin-version node_modules symlink that
// `hivemind embeddings install` creates.
//
// Why: `install` symlinks `<pluginDir>/node_modules` to
// `~/.hivemind/embed-deps/node_modules` so Node's standard module
// resolution finds @huggingface/transformers from anywhere inside
// `<pluginDir>/bundle/…`. But Claude Code's marketplace auto-upgrades drop
// new versioned cache dirs (`cache/hivemind/hivemind/0.7.27/`,
// `0.7.28/`, …) WITHOUT the symlink. Without intervention the user
// would have to re-run `hivemind embeddings install` after every
// marketplace upgrade — and most users won't, so embeddings would
// silently degrade.
//
// This helper runs from the capture hook on every session. The first
// session under a new plugin version creates the symlink; every other
// invocation is a cheap no-op.

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type SelfHealResult =
  | { kind: "linked"; target: string; link: string }
  | { kind: "already-linked"; target: string; link: string }
  | { kind: "shared-deps-missing"; target: string }
  | { kind: "plugin-owns-node-modules"; link: string }
  | { kind: "linked-elsewhere"; link: string; existingTarget: string }
  | { kind: "stale-link-removed"; link: string; danglingTarget: string }
  | { kind: "not-bundle-layout"; bundleDir: string }
  | { kind: "error"; detail: string };

export interface SelfHealOptions {
  /** Absolute path to the agent's `bundle/` dir (passed by the capture hook). */
  bundleDir: string;
  /** Override the target node_modules location (tests only). */
  sharedNodeModules?: string;
}

/**
 * Ensure `<pluginDir>/node_modules` is a symlink to
 * `~/.hivemind/embed-deps/node_modules`. Atomic, idempotent, conservative:
 * never clobbers an existing real `node_modules` dir, never overrides a
 * symlink that points elsewhere, and removes a dangling symlink (target
 * no longer exists) so the next call can re-create it.
 */
export function ensurePluginNodeModulesLink(opts: SelfHealOptions): SelfHealResult {
  // Guard against running from a non-bundle layout — e.g. tests that
  // import the capture hook from `src/hooks/capture.ts` shouldn't accidentally
  // symlink `src/node_modules` to the user's real shared deps. Every
  // shipped agent bundle puts the capture hook at `<pluginDir>/bundle/capture.js`,
  // so the bundleDir's basename is always "bundle" in production.
  if (basename(opts.bundleDir) !== "bundle") {
    return { kind: "not-bundle-layout", bundleDir: opts.bundleDir };
  }

  const target = opts.sharedNodeModules ?? join(homedir(), ".hivemind", "embed-deps", "node_modules");
  const pluginDir = dirname(opts.bundleDir);
  const link = join(pluginDir, "node_modules");

  // No shared deps installed yet — leave the plugin dir alone. The capture
  // hook's notification path covers user-facing surface for this case.
  if (!existsSync(target)) {
    return { kind: "shared-deps-missing", target };
  }

  // Check what currently exists at the link path.
  let linkStat;
  try {
    linkStat = lstatSync(link);
  } catch {
    // Nothing there — go create.
    return createSymlinkAtomic(target, link);
  }

  if (linkStat.isSymbolicLink()) {
    let existingTarget: string;
    try {
      existingTarget = readlinkSync(link);
    } catch (e: unknown) {
      return { kind: "error", detail: `readlink failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (existingTarget === target) {
      return { kind: "already-linked", target, link };
    }
    // Symlink to somewhere else — check whether the existing target
    // resolves to a real directory. If it doesn't, the link is dangling
    // and safe to remove + immediately re-create. Recreating in the same
    // call (rather than returning "stale-link-removed" and waiting for
    // the next session-start) means the CURRENT hook run lands with a
    // healed link, not the one after it.
    try {
      statSync(link); // follows symlink — throws on dangling
      // Real directory at a different target → don't override the user's choice.
      return { kind: "linked-elsewhere", link, existingTarget };
    } catch {
      try { rmSync(link); } catch { /* best-effort */ }
      // Fall through to atomic re-create. If that fails we return its
      // error rather than the stale-link-removed marker, since the link
      // is now genuinely absent.
      const recreated = createSymlinkAtomic(target, link);
      // Keep the diagnostic that a stale link was repaired so callers
      // can log the recovery — overload the existing variant with the
      // dangling target the link used to point at.
      if (recreated.kind === "linked") {
        return { kind: "stale-link-removed", link, danglingTarget: existingTarget };
      }
      return recreated;
    }
  }

  // Real directory or file at the link path — don't clobber.
  return { kind: "plugin-owns-node-modules", link };
}

function createSymlinkAtomic(target: string, link: string): SelfHealResult {
  try {
    const parent = dirname(link);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const tmp = `${link}.tmp.${process.pid}`;
    // If a stale tmp exists from a crashed prior run, remove it first.
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    symlinkSync(target, tmp);
    renameSync(tmp, link);
    return { kind: "linked", target, link };
  } catch (e: unknown) {
    return { kind: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
