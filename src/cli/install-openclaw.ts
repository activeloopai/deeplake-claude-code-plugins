import { existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, writeVersionStamp, log, warn } from "./util.js";
import { getVersion } from "./version.js";
import { ensureHivemindAllowlisted } from "../../openclaw/src/setup-config.js";

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
  // Wipe `dist/` before re-copying so we don't leave orphan files from a
  // previous install behind. Discovered live during the #170 E2E: the
  // skilify→skillify rename in #116 means an older bundle drops
  // `skilify-worker.js` (single-L), and copyDir (cpSync recursive) ADDS
  // files but never REMOVES ones missing from the source. The stale
  // single-L chunk then sits alongside the new double-L
  // `skillify-worker.js` and re-introduces ClawHub static-scan critical
  // findings (process.env reads + execFileSync) that the new build had
  // eliminated. Same risk for any future renamed/deleted chunk —
  // orphan-cleanup makes the installer's output deterministic regardless
  // of what was there before.
  rmSync(join(PLUGIN_DIR, "dist"), { recursive: true, force: true });
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

  // Patch ~/.openclaw/openclaw.json so the gateway actually loads us.
  // Without this, plugins.allow gates the plugin out — the files land
  // on disk but the loader never registers them, so `/hivemind_setup`
  // is unreachable from inside the agent (chicken-and-egg). The same
  // helper is shared with the slash command, so behavior stays
  // identical across both surfaces. See issue #121.
  //
  // Safe-by-default: if openclaw.json doesn't exist (gateway never
  // started) or is malformed, we skip silently. If plugins.allow is
  // absent/empty (default-allow), we leave it alone — only patch
  // explicit allowlists so we never flip the user into restrictive
  // mode and break their other plugins.
  const result = ensureHivemindAllowlisted();
  if (result.status === "added") {
    const touched: string[] = [];
    if (result.delta.pluginsAllow) touched.push("plugins.allow");
    if (result.delta.toolsAlsoAllow) touched.push("tools.alsoAllow");
    log(`  OpenClaw       patched ${touched.join(" + ")} in ${result.configPath}`);
    log(`  OpenClaw       backup: ${result.backupPath}`);
    log(`  OpenClaw       restart the gateway to activate: systemctl --user restart openclaw-gateway.service`);
    log(`  OpenClaw       capture starts on the NEXT turn — earlier turns are NOT backfilled`);
  } else if (result.status === "already-set") {
    log(`  OpenClaw       allowlist already covers hivemind in ${result.configPath}`);
  } else if (result.status === "error") {
    // "openclaw config file not found" is the common no-op case (gateway
    // never started). Log it at info-level — installer is non-fatal, the
    // /hivemind_setup slash command will patch on first openclaw run.
    // Other errors (malformed JSON, write failure) are user-actionable
    // and get a warn so they're visible. CodeRabbit on #124 caught the
    // previous silent-error path.
    if (result.error === "openclaw config file not found") {
      log(`  OpenClaw       openclaw.json not present at ${result.configPath} — run openclaw once, then \`hivemind claw install\` again`);
    } else {
      warn(`  OpenClaw       could not patch allowlist in ${result.configPath}: ${result.error}`);
    }
  }
}

export function uninstallOpenclaw(): void {
  if (existsSync(PLUGIN_DIR)) {
    rmSync(PLUGIN_DIR, { recursive: true, force: true });
    log(`  OpenClaw       removed ${PLUGIN_DIR}`);
  } else {
    log(`  OpenClaw       nothing to remove`);
  }
}
