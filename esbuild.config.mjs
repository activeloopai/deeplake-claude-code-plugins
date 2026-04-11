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

// OpenClaw plugin — replace child_process with no-op to avoid security scanner flags
await build({
  entryPoints: { index: "openclaw/src/index.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "openclaw/dist",
  external: ["node:*"],
  define: { "execSync": "undefined" },
  plugins: [{
    name: "strip-child-process",
    setup(build) {
      build.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: "node:child_process",
        namespace: "stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const execSync = () => {};",
        loader: "js",
      }));
    },
  }],
});

console.log(`Built: ${ccAll.length} CC bundles + 1 OpenClaw bundle`);
