import { build } from "esbuild";
import { chmodSync } from "node:fs";

const entryPoints = [
  "dist/hooks/session-start.js",
  "dist/hooks/capture.js",
  "dist/hooks/pre-tool-use.js",
];

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: ["node:*"],
});

for (const entry of entryPoints) {
  const filename = entry.split("/").pop();
  chmodSync(`bundle/${filename}`, 0o755);
}

console.log(`Bundled ${entryPoints.length} hooks into bundle/`);
