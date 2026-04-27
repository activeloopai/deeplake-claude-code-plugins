import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, readJson, writeJson, log } from "./util.js";
import { ensureMcpServerInstalled, buildMcpServerEntry } from "./install-mcp-shared.js";

// Cline (saoudrizwan.claude-dev) MCP config path:
//   Linux:   ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
//   macOS:   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
//   Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
//
// Format: { "mcpServers": { "<name>": { "command": "...", "args": [...] } } }
//
// This installer covers the Linux path. Re-verify with current Cline docs
// before changing for cross-platform: https://docs.cline.bot/

const CONFIG_PATH = join(
  HOME,
  ".config",
  "Code",
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "settings",
  "cline_mcp_settings.json",
);

const SERVER_KEY = "hivemind";

interface ClineConfig {
  mcpServers?: Record<string, unknown>;
}

export function installCline(): void {
  ensureMcpServerInstalled();

  const cfg = (readJson<ClineConfig>(CONFIG_PATH) ?? {}) as ClineConfig;
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[SERVER_KEY] = buildMcpServerEntry();
  writeJson(CONFIG_PATH, cfg);

  log(`  Cline          MCP server registered in ${CONFIG_PATH}`);
}

export function uninstallCline(): void {
  const cfg = readJson<ClineConfig>(CONFIG_PATH);
  if (!cfg?.mcpServers || !(SERVER_KEY in cfg.mcpServers)) {
    log("  Cline          nothing to remove");
    return;
  }
  delete cfg.mcpServers[SERVER_KEY];
  if (Object.keys(cfg.mcpServers).length === 0) {
    delete cfg.mcpServers;
  }
  if (Object.keys(cfg).length === 0) {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } else {
    writeJson(CONFIG_PATH, cfg);
  }
  log(`  Cline          MCP entry removed from ${CONFIG_PATH}`);
}
