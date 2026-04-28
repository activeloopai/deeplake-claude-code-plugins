import { existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

const PLUGIN_DIR = join(HOME, ".openclaw", "extensions", "hivemind");

export function installOpenclaw(): void {
  const srcDist = join(pkgRoot(), "openclaw", "dist");
  const srcManifest = join(pkgRoot(), "openclaw", "openclaw.plugin.json");
  const srcPkg = join(pkgRoot(), "openclaw", "package.json");
  const srcSkills = join(pkgRoot(), "openclaw", "skills");

  if (!existsSync(srcDist)) {
    throw new Error(`OpenClaw bundle missing at ${srcDist}. Run 'npm run build' first.`);
  }

  ensureDir(PLUGIN_DIR);
  copyDir(srcDist, join(PLUGIN_DIR, "dist"));
  // copyDir uses cpSync({ recursive: true }) and is for directories. It
  // works on files today, but if a directory ever exists at the
  // destination path the file lands inside it instead of replacing it.
  // Use copyFileSync for individual files.
  if (existsSync(srcManifest)) copyFileSync(srcManifest, join(PLUGIN_DIR, "openclaw.plugin.json"));
  if (existsSync(srcPkg)) copyFileSync(srcPkg, join(PLUGIN_DIR, "package.json"));
  if (existsSync(srcSkills)) copyDir(srcSkills, join(PLUGIN_DIR, "skills"));

  writeVersionStamp(PLUGIN_DIR, getVersion());
  log(`  OpenClaw       installed -> ${PLUGIN_DIR}`);
}

export function uninstallOpenclaw(): void {
  if (existsSync(PLUGIN_DIR)) {
    rmSync(PLUGIN_DIR, { recursive: true, force: true });
    log(`  OpenClaw       removed ${PLUGIN_DIR}`);
  } else {
    log(`  OpenClaw       nothing to remove`);
  }
}
