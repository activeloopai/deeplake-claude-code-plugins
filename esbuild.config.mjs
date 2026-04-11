import { build } from "esbuild";
import { chmodSync } from "node:fs";

// Claude Code plugin
const ccHooks = [
  { entry: "dist/src/hooks/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/capture.js", out: "capture" },
  { entry: "dist/src/hooks/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/session-end.js", out: "session-end" },
  { entry: "dist/src/hooks/wiki-worker.js", out: "wiki-worker" },
];

const ccShell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const ccCommands = [
  { entry: "dist/src/commands/auth-login.js", out: "commands/auth-login" },
];

const ccAll = [...ccHooks, ...ccShell, ...ccCommands];

await build({
  entryPoints: Object.fromEntries(ccAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "claude-code/bundle",
  external: ["node:*", "node-liblzma", "@mongodb-js/zstd"],
});

for (const h of ccAll) {
  chmodSync(`claude-code/bundle/${h.out}.js`, 0o755);
}

// Codex plugin
const codexHooks = [
  { entry: "dist/src/hooks/codex/session-start.js", out: "session-start" },
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

const codexAll = [...codexHooks, ...codexShell, ...codexCommands];

await build({
  entryPoints: Object.fromEntries(codexAll.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "codex/bundle",
  external: ["node:*", "node-liblzma", "@mongodb-js/zstd"],
});

for (const h of codexAll) {
  chmodSync(`codex/bundle/${h.out}.js`, 0o755);
}

// OpenClaw plugin
await build({
  entryPoints: { index: "openclaw/src/index.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "openclaw/dist",
  external: ["node:*"],
});

console.log(`Built: ${ccAll.length} CC + ${codexAll.length} Codex + 1 OpenClaw bundles`);
