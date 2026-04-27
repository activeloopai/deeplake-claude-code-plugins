import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, readJson, writeJson, log } from "./util.js";
import { ensureMcpServerInstalled, buildMcpServerEntry } from "./install-mcp-shared.js";

// Roo Code (rooveterinaryinc.roo-cline) MCP config:
//   Linux:   ~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json
//
// Roo is a Cline fork; the config schema is the same { mcpServers: {...} } shape.
// Re-verify with current Roo docs before changing for cross-platform:
//   https://docs.roocode.com/features/mcp/using-mcp-in-roo

const CONFIG_PATH = join(
  HOME,
  ".config",
  "Code",
  "User",
  "globalStorage",
  "rooveterinaryinc.roo-cline",
  "settings",
  "mcp_settings.json",
);

const SERVER_KEY = "hivemind";

interface RooConfig {
  mcpServers?: Record<string, unknown>;
}

export function installRoo(): void {
  ensureMcpServerInstalled();

  const cfg = (readJson<RooConfig>(CONFIG_PATH) ?? {}) as RooConfig;
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY] = buildMcpServerEntry();
  writeJson(CONFIG_PATH, cfg);

  log(`  Roo Code       MCP server registered in ${CONFIG_PATH}`);
}

export function uninstallRoo(): void {
  const cfg = readJson<RooConfig>(CONFIG_PATH);
  if (!cfg?.mcpServers || !(SERVER_KEY in cfg.mcpServers)) {
    log("  Roo Code       nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY];
  if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
  if (Object.keys(cfg).length === 0) {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } else {
    writeJson(CONFIG_PATH, cfg);
  }
  log(`  Roo Code       MCP entry removed from ${CONFIG_PATH}`);
}
