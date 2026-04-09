import { build } from "esbuild";
import { chmodSync } from "node:fs";

// tsc compiles from repo root into dist/
// Entry points reference the dist output
const hooks = [
  { entry: "../dist/src/hooks/session-start.js", out: "session-start" },
  { entry: "../dist/src/hooks/capture.js", out: "capture" },
  { entry: "../dist/src/hooks/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "../dist/src/hooks/session-end.js", out: "session-end" },
  { entry: "../dist/src/hooks/wiki-worker.js", out: "wiki-worker" },
];

const shell = [
  { entry: "../dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const commands = [
  { entry: "../dist/src/commands/auth-login.js", out: "commands/auth-login" },
];

const all = [...hooks, ...shell, ...commands];

await build({
  entryPoints: Object.fromEntries(all.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: ["node:*", "node-liblzma", "@mongodb-js/zstd"],
});

for (const h of all) {
  chmodSync(`bundle/${h.out}.js`, 0o755);
}

console.log(`Bundled ${all.length} entries into bundle/`);
