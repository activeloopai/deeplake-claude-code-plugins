import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  external: ["node:*"],
});

console.log("Built openclaw/dist/index.js");
