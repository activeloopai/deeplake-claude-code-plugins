import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, readJson, writeJson, log } from "./util.js";
import { ensureMcpServerInstalled, buildMcpServerEntry } from "./install-mcp-shared.js";

// Kilo Code MCP config:
//   global: ~/.kilocode/mcp.json
//   project: <project>/.kilocode/mcp.json
//
// Kilo is a Roo fork (Roo is a Cline fork) so the config schema is the same
// { mcpServers: {...} } shape used by Cline and Roo.
// Re-verify with current Kilo docs before changing for cross-platform:
//   https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code

const CONFIG_PATH = join(HOME, ".kilocode", "mcp.json");

const SERVER_KEY = "hivemind";

interface KiloConfig {
  mcpServers?: Record<string, unknown>;
}

export function installKilo(): void {
  ensureMcpServerInstalled();

  const cfg = (readJson<KiloConfig>(CONFIG_PATH) ?? {}) as KiloConfig;
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY] = buildMcpServerEntry();
  writeJson(CONFIG_PATH, cfg);

  log(`  Kilo Code      MCP server registered in ${CONFIG_PATH}`);
}

export function uninstallKilo(): void {
  const cfg = readJson<KiloConfig>(CONFIG_PATH);
  if (!cfg?.mcpServers || !(SERVER_KEY in cfg.mcpServers)) {
    log("  Kilo Code      nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY];
  if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
  if (Object.keys(cfg).length === 0) {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } else {
    writeJson(CONFIG_PATH, cfg);
  }
  log(`  Kilo Code      MCP entry removed from ${CONFIG_PATH}`);
}
