import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pkgRoot } from "./util.js";

export function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
