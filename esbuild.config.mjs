import { build } from "esbuild";
import { chmodSync, writeFileSync, readFileSync } from "node:fs";

const esmPackageJson = '{"type":"module"}\n';
const hivemindVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
const openclawVersion = JSON.parse(readFileSync("openclaw/package.json", "utf-8")).version;
const openclawSkillBody = readFileSync("openclaw/skills/SKILL.md", "utf-8");

// Claude Code plugin
const ccHooks = [
  { entry: "dist/src/hooks/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/session-start-setup.js", out: "session-start-setup" },
  { entry: "dist/src/hooks/session-notifications.js", out: "session-notifications" },
  { entry: "dist/src/hooks/capture.js", out: "capture" },
  { entry: "dist/src/hooks/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/plugin-cache-gc.js", out: "plugin-cache-gc" },
  { entry: "dist/src/hooks/wiki-worker.js", out: "wiki-worker" },
  { entry: "dist/src/skillify/skillify-worker.js", out: "skillify-worker" },
];

const ccShell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const ccCommands = [
  { entry: "dist/src/commands/auth-login.js", out: "commands/auth-login" },
];

const ccEmbed = [
  { entry: "dist/src/embeddings/daemon.js", out: "embeddings/embed-daemon" },
];

const ccAll = [...ccHooks, ...ccShell, ...ccCommands, ...ccEmbed];

await build({
  entryPoints: Object.fromEntries(ccAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "claude-code/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
  },
});

for (const h of ccAll) {
  chmodSync(`claude-code/bundle/${h.out}.js`, 0o755);
}
writeFileSync("claude-code/bundle/package.json", esmPackageJson);

// Codex plugin
const codexHooks = [
  { entry: "dist/src/hooks/codex/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/codex/session-start-setup.js", out: "session-start-setup" },
  { entry: "dist/src/hooks/codex/capture.js", out: "capture" },
  { entry: "dist/src/hooks/codex/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/codex/stop.js", out: "stop" },
  { entry: "dist/src/hooks/codex/wiki-worker.js", out: "wiki-worker" },
  { entry: "dist/src/skillify/skillify-worker.js", out: "skillify-worker" },
];

const codexShell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const codexCommands = [
  { entry: "dist/src/commands/auth-login.js", out: "commands/auth-login" },
];

const codexEmbed = [
  { entry: "dist/src/embeddings/daemon.js", out: "embeddings/embed-daemon" },
];

const codexAll = [...codexHooks, ...codexShell, ...codexCommands, ...codexEmbed];

await build({
  entryPoints: Object.fromEntries(codexAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "codex/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
  },
});

for (const h of codexAll) {
  chmodSync(`codex/bundle/${h.out}.js`, 0o755);
}
writeFileSync("codex/bundle/package.json", esmPackageJson);

// Cursor plugin (1.7+ hooks API). Same shell + commands as the other agents.
const cursorHooks = [
  { entry: "dist/src/hooks/cursor/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/cursor/capture.js", out: "capture" },
  { entry: "dist/src/hooks/cursor/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/cursor/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/cursor/wiki-worker.js", out: "wiki-worker" },
  { entry: "dist/src/skillify/skillify-worker.js", out: "skillify-worker" },
];

// Hermes Agent shell-hook bundles (matches Claude Code's wire protocol; see
// agent/shell_hooks.py in NousResearch/hermes-agent).
const hermesHooks = [
  { entry: "dist/src/hooks/hermes/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/hermes/capture.js", out: "capture" },
  { entry: "dist/src/hooks/hermes/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/hermes/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/hermes/wiki-worker.js", out: "wiki-worker" },
  { entry: "dist/src/skillify/skillify-worker.js", out: "skillify-worker" },
];

const cursorShell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const cursorCommands = [
  { entry: "dist/src/commands/auth-login.js", out: "commands/auth-login" },
];

const cursorEmbed = [
  { entry: "dist/src/embeddings/daemon.js", out: "embeddings/embed-daemon" },
];

const cursorAll = [...cursorHooks, ...cursorShell, ...cursorCommands, ...cursorEmbed];

await build({
  entryPoints: Object.fromEntries(cursorAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "cursor/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
  },
});

for (const h of cursorAll) {
  chmodSync(`cursor/bundle/${h.out}.js`, 0o755);
}
writeFileSync("cursor/bundle/package.json", esmPackageJson);

// Hermes Agent bundle (auto-capture via on_session_start / pre_llm_call /
// post_tool_call / post_llm_call / on_session_end).
const hermesShell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];
const hermesCommands = [
  { entry: "dist/src/commands/auth-login.js", out: "commands/auth-login" },
];
const hermesEmbed = [
  { entry: "dist/src/embeddings/daemon.js", out: "embeddings/embed-daemon" },
];
const hermesAll = [...hermesHooks, ...hermesShell, ...hermesCommands, ...hermesEmbed];

await build({
  entryPoints: Object.fromEntries(hermesAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "hermes/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
  },
});

for (const h of hermesAll) {
  chmodSync(`hermes/bundle/${h.out}.js`, 0o755);
}

// Pi (badlogic/pi-mono) — ships a wiki-worker bundle, a skillify-worker
// bundle, and an autopull-worker bundle. The pi extension itself is raw .ts
// at pi/extension-source/hivemind.ts; we don't bundle it because pi's
// runtime compiles + loads the .ts file directly. Embed daemon reuses the
// canonical ~/.hivemind/embed-deps/embed-daemon.js — no per-pi embed
// bundle needed. Skillify worker is the same shared module used by
// CC/Codex/Cursor/Hermes; pi spawns it from session_shutdown.
// Autopull worker is the same maybeAutoPull() the other agents call
// directly; pi can't import it (raw .ts, zero deps) so it spawns this
// bundle synchronously from session_start.
const piWorker = [
  { entry: "dist/src/hooks/pi/wiki-worker.js", out: "wiki-worker" },
  { entry: "dist/src/skillify/skillify-worker.js", out: "skillify-worker" },
  { entry: "dist/src/skillify/autopull-worker.js", out: "autopull-worker" },
];
await build({
  entryPoints: Object.fromEntries(piWorker.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "pi/bundle",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
  },
});
for (const h of piWorker) {
  chmodSync(`pi/bundle/${h.out}.js`, 0o755);
}
writeFileSync("pi/bundle/package.json", esmPackageJson);
writeFileSync("hermes/bundle/package.json", esmPackageJson);

// OpenClaw plugin bundle. The shared CC/Codex source modules reference a
// handful of HIVEMIND_* env vars for dev-only overrides. Those env paths are
// never taken in the openclaw runtime (the plugin loads config from
// pluginApi.pluginConfig + ~/.deeplake/credentials.json), so we replace them
// with `undefined` at build time to avoid shipping dead env-read code in the
// plugin bundle.
await build({
  entryPoints: { index: "openclaw/src/index.ts" },
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "node",
  format: "esm",
  outdir: "openclaw/dist",
  external: ["node:*"],
  // Guarantee `globalThis.__hivemind_tuning__` exists as an object before any
  // bundled module's lazy env reads execute. esbuild's `define` rewrites
  // `process.env.HIVEMIND_X` → `globalThis.__hivemind_tuning__.HIVEMIND_X`
  // (no optional chaining — esbuild rejects it as a define value). The
  // openclaw plugin's `applyOpenclawTuning()` replaces this object with the
  // user's `plugins.entries.hivemind.config.tuning` values in register();
  // until then, reads against the empty object resolve to `undefined` and
  // the call-site `??` fallback applies.
  banner: { js: "globalThis.__hivemind_tuning__ ??= {};" },
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(openclawVersion),
    __HIVEMIND_SKILL__: JSON.stringify(openclawSkillBody),
    // ----- Credentials / identity: openclaw-managed via the auth flow -----
    // These are owned by the openclaw plugin's login + plugin-config paths,
    // not by user-tunable env vars. Inline to `undefined` so any rogue
    // `process.env.X` read in shared code can't accidentally leak or be
    // injected. Keep these `undefined` — do NOT migrate them to the tuning
    // dispatch.
    "process.env.HIVEMIND_TOKEN": "undefined",
    "process.env.HIVEMIND_ORG_ID": "undefined",
    "process.env.HIVEMIND_WORKSPACE_ID": "undefined",
    "process.env.HIVEMIND_API_URL": "undefined",
    "process.env.HIVEMIND_TABLE": "undefined",
    "process.env.HIVEMIND_SESSIONS_TABLE": "undefined",
    "process.env.HIVEMIND_MEMORY_PATH": "undefined",
    "process.env.HIVEMIND_CAPTURE": "undefined",
    // ----- User-tunable knobs: routed through a globalThis dispatch -----
    // Every read of `process.env.HIVEMIND_X` in transitively-bundled code is
    // rewritten by esbuild to `globalThis.__hivemind_tuning__.HIVEMIND_X`.
    // The openclaw plugin's `register()` populates that object from
    // `pluginApi.pluginConfig.tuning` (i.e. what the user wrote under
    // `plugins.entries.hivemind.config.tuning` in `openclaw.json`). So the
    // bundle has zero `process.env.X` substrings (ClawHub scan passes), AND
    // the user can still tune at runtime by editing openclaw.json + restart.
    // CodeRabbit + @efenocchi on #170 pushed back on the previous
    // inline-to-undefined approach because it removed the env-override
    // surface entirely. This restores it via a different mechanism.
    "process.env.HIVEMIND_DEBUG": "globalThis.__hivemind_tuning__.HIVEMIND_DEBUG",
    "process.env.HIVEMIND_TRACE_SQL": "globalThis.__hivemind_tuning__.HIVEMIND_TRACE_SQL",
    "process.env.HIVEMIND_QUERY_TIMEOUT_MS": "globalThis.__hivemind_tuning__.HIVEMIND_QUERY_TIMEOUT_MS",
    "process.env.HIVEMIND_INDEX_MARKER_TTL_MS": "globalThis.__hivemind_tuning__.HIVEMIND_INDEX_MARKER_TTL_MS",
    "process.env.HIVEMIND_INDEX_MARKER_DIR": "globalThis.__hivemind_tuning__.HIVEMIND_INDEX_MARKER_DIR",
    "process.env.HIVEMIND_SEMANTIC_LIMIT": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_LIMIT",
    "process.env.HIVEMIND_HYBRID_LEXICAL_LIMIT": "globalThis.__hivemind_tuning__.HIVEMIND_HYBRID_LEXICAL_LIMIT",
    "process.env.HIVEMIND_GREP_LIKE": "globalThis.__hivemind_tuning__.HIVEMIND_GREP_LIKE",
    "process.env.HIVEMIND_SEMANTIC_SEARCH": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_SEARCH",
    "process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS",
    "process.env.HIVEMIND_SEMANTIC_EMIT_ALL": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_EMIT_ALL",
    // `HIVEMIND_STATE_DIR` is the test-isolation override that points
    // `~/.deeplake/state/skillify` at a `mkdtempSync()` dir. OpenClaw has
    // no testing surface and no reason to redirect state, so it always
    // resolves to `undefined` at runtime — the call-site `??
    // homedir()/...` fallback produces the production path. The rewrite
    // matters mainly to keep the ClawHub `env-harvesting` scanner happy:
    // a literal `process.env.HIVEMIND_STATE_DIR` substring in the same
    // file as a network send trips the critical rule even though the
    // value is just a directory path.
    "process.env.HIVEMIND_STATE_DIR": "globalThis.__hivemind_tuning__.HIVEMIND_STATE_DIR",
  },
  plugins: [{
    // Dead-code elimination for transitively bundled CC/Codex-only features.
    // openclaw/src/index.ts imports shared modules from ../../src/ (DeeplakeApi,
    // grep-core, virtual-table-query, auth device-flow). Several of those
    // modules also host CC-specific helpers that shell out with execSync —
    // opening the browser for SSO, nudging claude-plugin-update, spawning the
    // wiki-worker daemon. Those helpers are never called through the openclaw
    // entry point (openclaw is a pure HTTP/WebSocket gateway; it has no local
    // browser, uses its own plugin installer, and does not run the wiki-worker
    // daemon). Replacing node:child_process with a no-op export drops that
    // dead code from the bundle instead of shipping unreachable exec calls.
    name: "stub-unused-child-process",
    setup(build) {
      build.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: "node:child_process",
        namespace: "stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const execSync = () => {}; export const execFileSync = () => {}; export const spawn = () => {};",
        loader: "js",
      }));
    },
  }],
});
writeFileSync("openclaw/dist/package.json", esmPackageJson);

// OpenClaw skillify-worker bundle. Same shared module CC/Codex/Cursor/Hermes/Pi
// use; openclaw spawns it from its agent_end hook to mine reusable skills out
// of just-captured sessions. Built as a SEPARATE entry (not added to the main
// openclaw build above) because:
//   1. The main bundle stubs out node:child_process to drop CC-only dead code.
//      The worker genuinely needs spawn at runtime, so it gets its own bundle
//      with no stubs.
//   2. The main bundle uses code splitting (chunks/), and we don't want the
//      worker's modules entangled with the gateway's chunk graph.
// Lands at openclaw/dist/skillify-worker.js — install-openclaw.ts already
// copies the entire dist/ recursively, so it ships to
// ~/.openclaw/extensions/hivemind/dist/skillify-worker.js with no other change.
await build({
  entryPoints: { "skillify-worker": "dist/src/skillify/skillify-worker.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "openclaw/dist",
  external: ["node:*"],
  // Same banner as the main openclaw bundle — see the comment there for
  // the rationale. The worker entry itself overwrites this with the
  // tuning passed in via the config JSON before any shared module's
  // lazy env read fires.
  banner: { js: "globalThis.__hivemind_tuning__ ??= {};" },
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(hivemindVersion),
    // Every `process.env.HIVEMIND_X` read in transitively-bundled code is
    // rewritten by esbuild to `globalThis.__hivemind_tuning__.HIVEMIND_X`.
    // The worker entry (src/skillify/skillify-worker.ts) populates that
    // object from its config JSON before any shared code path runs (the
    // openclaw plugin writes the user's `pluginConfig.tuning` into the
    // config JSON when spawning the worker). Net result:
    //   - openclaw bundle has zero `process.env.X` substrings (ClawHub scan
    //     passes per the env-harvesting rule)
    //   - user-tunable knobs (timeouts, debug, skillify cadence, agent
    //     models, etc.) still take effect at runtime via openclaw.json's
    //     `plugins.entries.hivemind.config.tuning` section
    //   - HIVEMIND_SKILLIFY_WORKER=1 is set by the worker entry so the
    //     recursion guard inside trigger code short-circuits correctly
    //
    // CodeRabbit + @efenocchi pushed back on the prior inline-to-undefined
    // version because it silently removed every env-override surface. This
    // restores them via a build-time-friendly dispatch.
    //
    // The list below MUST cover every `process.env.HIVEMIND_*` that may be
    // transitively imported into the worker bundle. Source of truth:
    //   grep -rn "process\.env\.HIVEMIND_" src/skillify src/shell \
    //       src/deeplake-api.ts src/utils src/hooks/virtual-table-query.ts
    "process.env.HIVEMIND_DEBUG": "globalThis.__hivemind_tuning__.HIVEMIND_DEBUG",
    "process.env.HIVEMIND_TRACE_SQL": "globalThis.__hivemind_tuning__.HIVEMIND_TRACE_SQL",
    "process.env.HIVEMIND_QUERY_TIMEOUT_MS": "globalThis.__hivemind_tuning__.HIVEMIND_QUERY_TIMEOUT_MS",
    "process.env.HIVEMIND_SEMANTIC_LIMIT": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_LIMIT",
    "process.env.HIVEMIND_SEMANTIC_SEARCH": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_SEARCH",
    "process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS",
    "process.env.HIVEMIND_SEMANTIC_EMIT_ALL": "globalThis.__hivemind_tuning__.HIVEMIND_SEMANTIC_EMIT_ALL",
    "process.env.HIVEMIND_INDEX_MARKER_TTL_MS": "globalThis.__hivemind_tuning__.HIVEMIND_INDEX_MARKER_TTL_MS",
    "process.env.HIVEMIND_INDEX_MARKER_DIR": "globalThis.__hivemind_tuning__.HIVEMIND_INDEX_MARKER_DIR",
    "process.env.HIVEMIND_CURSOR_MODEL": "globalThis.__hivemind_tuning__.HIVEMIND_CURSOR_MODEL",
    "process.env.HIVEMIND_HERMES_PROVIDER": "globalThis.__hivemind_tuning__.HIVEMIND_HERMES_PROVIDER",
    "process.env.HIVEMIND_HERMES_MODEL": "globalThis.__hivemind_tuning__.HIVEMIND_HERMES_MODEL",
    "process.env.HIVEMIND_PI_PROVIDER": "globalThis.__hivemind_tuning__.HIVEMIND_PI_PROVIDER",
    "process.env.HIVEMIND_PI_MODEL": "globalThis.__hivemind_tuning__.HIVEMIND_PI_MODEL",
    "process.env.HIVEMIND_SKILLIFY_WORKER": "globalThis.__hivemind_tuning__.HIVEMIND_SKILLIFY_WORKER",
    "process.env.HIVEMIND_SKILLIFY_EVERY_N_TURNS": "globalThis.__hivemind_tuning__.HIVEMIND_SKILLIFY_EVERY_N_TURNS",
    "process.env.HIVEMIND_AUTOPULL_DISABLED": "globalThis.__hivemind_tuning__.HIVEMIND_AUTOPULL_DISABLED",
    // Skillify state-dir test-isolation override. OpenClaw never needs
    // to redirect state, so this rewrites to `undefined` at runtime and
    // the call-site fallback produces the homedir-based production path.
    // The rewrite primarily satisfies the ClawHub `env-harvesting`
    // scanner — see the matching entry in the main openclaw build above.
    "process.env.HIVEMIND_STATE_DIR": "globalThis.__hivemind_tuning__.HIVEMIND_STATE_DIR",
  },
});
chmodSync("openclaw/dist/skillify-worker.js", 0o755);

// Hivemind MCP server (stdio). Reused by Cline / Roo / Kilo / any MCP-aware
// agent. Lives at ~/.hivemind/mcp/server.js after install.
await build({
  entryPoints: { server: "dist/src/mcp/server.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "mcp/bundle",
  external: ["node:*", "node-liblzma", "@mongodb-js/zstd"],
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("mcp/bundle/server.js", 0o755);
writeFileSync("mcp/bundle/package.json", esmPackageJson);

// Unified CLI (`npx hivemind install` … single entrypoint for all assistants)
await build({
  entryPoints: { cli: "dist/src/cli/index.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: ["node:*", "node-liblzma", "@mongodb-js/zstd"],
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("bundle/cli.js", 0o755);

// Standalone embed daemon bundle. `hivemind embeddings install` deposits
// this at ~/.hivemind/embed-deps/embed-daemon.js so every agent (including
// pi, which can't ship per-agent bundles) spawns the same canonical
// daemon. Externals match the per-agent daemon bundles — the daemon
// resolves them from its sibling node_modules (the shared deps dir).
await build({
  entryPoints: { "embed-daemon": "dist/src/embeddings/daemon.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "embeddings",
  external: [
    "node:*",
    "node-liblzma",
    "@mongodb-js/zstd",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
});
chmodSync("embeddings/embed-daemon.js", 0o755);

console.log(`Built: ${ccAll.length} CC + ${codexAll.length} Codex + ${cursorAll.length} Cursor + ${hermesAll.length} Hermes + 1 OpenClaw + 1 MCP + 1 CLI + 1 standalone-daemon bundle`);
