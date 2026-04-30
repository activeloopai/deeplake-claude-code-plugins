import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, pkgRoot, ensureDir, copyDir, writeVersionStamp, log } from "./util.js";
import { getVersion } from "./version.js";

// Shared installer logic for the hivemind MCP server.
//
// All Tier B consumers (Cline, Roo Code, Kilo Code) share one MCP server
// binary at ~/.hivemind/mcp/server.js. Per-consumer installers register
// that absolute path in their own MCP config file.

export const HIVEMIND_DIR = join(HOME, ".hivemind");
export const MCP_DIR = join(HIVEMIND_DIR, "mcp");
export const MCP_SERVER_PATH = join(MCP_DIR, "server.js");
export const MCP_PACKAGE_JSON = join(MCP_DIR, "package.json");

/** Copy the bundled MCP server into ~/.hivemind/mcp/ if missing or out of date. */
export function ensureMcpServerInstalled(): void {
  const srcDir = join(pkgRoot(), "mcp", "bundle");
  if (!existsSync(srcDir)) {
    throw new Error(
      `MCP server bundle missing at ${srcDir}. Run 'npm run build' to produce it before installing Tier B consumers.`,
    );
  }
  ensureDir(MCP_DIR);
  copyDir(srcDir, MCP_DIR);
  writeVersionStamp(HIVEMIND_DIR, getVersion());
  log(`  hivemind-mcp   server installed -> ${MCP_SERVER_PATH}`);
}

/** Standard MCP server descriptor for stdio transport. */
export function buildMcpServerEntry(): Record<string, unknown> {
  return {
    command: "node",
    args: [MCP_SERVER_PATH],
  };
}
