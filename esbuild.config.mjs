import { build } from "esbuild";
import { chmodSync } from "node:fs";

const entryPoints = [
  "dist/hooks/session-start.js",
  "dist/hooks/capture.js",
  "dist/hooks/pre-tool-use.js",
  "dist/hooks/post-tool-use.js",
  "dist/shell/deeplake-shell.js",
];

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  // just-bash uses dynamic chunk imports that can't be inlined by esbuild
  external: ["node:*", "just-bash"],
});

for (const entry of entryPoints) {
  const filename = entry.split("/").pop();
  chmodSync(`bundle/${filename}`, 0o755);
}

console.log(`Bundled ${entryPoints.length} entries into bundle/`);
