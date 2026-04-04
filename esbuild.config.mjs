import { build } from "esbuild";
import { chmodSync } from "node:fs";

const entryPoints = [
  "dist/hooks/session-start.js",
  "dist/hooks/capture.js",
  "dist/hooks/pre-tool-use.js",
<<<<<<< HEAD
  "dist/hooks/post-tool-use.js",
  "dist/shell/deeplake-shell.js",
=======
>>>>>>> main
];

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  // deeplake SDK ships its own WASM binary — keep it external so
  // esbuild doesn't try to inline the 63MB .wasm file
  external: ["node:*", "deeplake"],
});

for (const entry of entryPoints) {
  const filename = entry.split("/").pop();
  chmodSync(`bundle/${filename}`, 0o755);
}

console.log(`Bundled ${entryPoints.length} entries into bundle/`);
