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
  { entry: "dist/src/hooks/capture.js", out: "capture" },
  { entry: "dist/src/hooks/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/plugin-cache-gc.js", out: "plugin-cache-gc" },
  { entry: "dist/src/hooks/wiki-worker.js", out: "wiki-worker" },
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
];

// Hermes Agent shell-hook bundles (matches Claude Code's wire protocol; see
// agent/shell_hooks.py in NousResearch/hermes-agent).
const hermesHooks = [
  { entry: "dist/src/hooks/hermes/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/hermes/capture.js", out: "capture" },
  { entry: "dist/src/hooks/hermes/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/hermes/pre-tool-use.js", out: "pre-tool-use" },
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
  define: {
    __HIVEMIND_VERSION__: JSON.stringify(openclawVersion),
    __HIVEMIND_SKILL__: JSON.stringify(openclawSkillBody),
    "process.env.HIVEMIND_TOKEN": "undefined",
    "process.env.HIVEMIND_ORG_ID": "undefined",
    "process.env.HIVEMIND_WORKSPACE_ID": "undefined",
    "process.env.HIVEMIND_API_URL": "undefined",
    "process.env.HIVEMIND_TABLE": "undefined",
    "process.env.HIVEMIND_SESSIONS_TABLE": "undefined",
    "process.env.HIVEMIND_MEMORY_PATH": "undefined",
    "process.env.HIVEMIND_DEBUG": "undefined",
    "process.env.HIVEMIND_CAPTURE": "undefined",
    "process.env.HIVEMIND_TRACE_SQL": "undefined",
    "process.env.HIVEMIND_QUERY_TIMEOUT_MS": "undefined",
    "process.env.HIVEMIND_INDEX_MARKER_TTL_MS": "undefined",
    "process.env.HIVEMIND_INDEX_MARKER_DIR": "undefined",
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

console.log(`Built: ${ccAll.length} CC + ${codexAll.length} Codex + ${cursorAll.length} Cursor + ${hermesAll.length} Hermes + 1 OpenClaw + 1 MCP + 1 CLI bundle`);
