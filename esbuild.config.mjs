import { build } from "esbuild";
import { chmodSync } from "node:fs";

const hooks = [
  { entry: "dist/src/hooks/session-start.js", out: "session-start" },
  { entry: "dist/src/hooks/capture.js", out: "capture" },
  { entry: "dist/src/hooks/pre-tool-use.js", out: "pre-tool-use" },
  { entry: "dist/src/hooks/post-tool-use.js", out: "post-tool-use" },
];

const shell = [
  { entry: "dist/src/shell/deeplake-shell.js", out: "shell/deeplake-shell" },
];

const all = [...hooks, ...shell];

await build({
  entryPoints: Object.fromEntries(all.map(h => [h.out, h.entry])),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: ["node:*", "deeplake", "node-liblzma", "@mongodb-js/zstd"],
});

for (const h of all) {
  chmodSync(`bundle/${h.out}.js`, 0o755);
}

console.log(`Bundled ${all.length} entries into bundle/`);
