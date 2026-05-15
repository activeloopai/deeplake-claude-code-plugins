/**
 * Hermes pre_tool_call hook (matcher: "terminal").
 *
 * Defense-in-depth for memory recall accuracy. The agent's preferred path
 * is the hivemind_search MCP tool — but if it ignores the skill guidance
 * and runs `rg` / `grep` against ~/.deeplake/memory/ via terminal, we
 * intercept that here and return the same SQL fast-path result other
 * Tier 1 agents (Claude / Codex / Cursor) get from their PreToolUse
 * interceptors.
 *
 * Hermes pre_tool_call output convention (from agent/shell_hooks.py):
 *   {"action": "block", "message": "..."}   — Hermes-canonical
 *   {"decision": "block", "reason": "..."}  — Claude-Code-style (also accepted)
 *
 * No command-rewrite is supported on this event, so we use "block" + the
 * SQL search results inlined as the block message. The agent sees the
 * actual data + a nudge toward the MCP tool.
 *
 * Returns nothing (silent fall-through) when the command isn't aimed at
 * our memory mount — Hermes runs the original command unmodified.
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { log as _log } from "../../utils/debug.js";
import { parseBashGrep, handleGrepDirect } from "../grep-direct.js";
import { touchesMemory, rewritePaths } from "../memory-path-utils.js";
import { readVirtualPathContent } from "../virtual-table-query.js";
const log = (msg: string) => _log("hermes-pre-tool-use", msg);

/**
 * Same minimal cat/head/tail parser as cursor/pre-tool-use. Without this
 * Hermes can't serve `cat ~/.deeplake/memory/index.md` from the virtual
 * filesystem and the agent gets ENOENT for the very file SessionStart
 * tells it to read first.
 */
function parseCatHeadTail(rewritten: string): { virtualPath: string; lineLimit: number; fromEnd: boolean } | null {
  const cmd = rewritten.replace(/\s+2>\S+/g, "").trim();
  const catPipeHead = cmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
  if (catPipeHead) return { virtualPath: catPipeHead[1], lineLimit: Math.abs(parseInt(catPipeHead[2], 10)), fromEnd: false };
  const catMatch = cmd.match(/^cat\s+(\S+)\s*$/);
  if (catMatch) return { virtualPath: catMatch[1], lineLimit: 0, fromEnd: false };
  const headMatch = cmd.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? cmd.match(/^head\s+(\S+)\s*$/);
  if (headMatch) {
    if (headMatch[2]) return { virtualPath: headMatch[2], lineLimit: Math.abs(parseInt(headMatch[1], 10)), fromEnd: false };
    return { virtualPath: headMatch[1], lineLimit: 10, fromEnd: false };
  }
  const tailMatch = cmd.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ?? cmd.match(/^tail\s+(\S+)\s*$/);
  if (tailMatch) {
    if (tailMatch[2]) return { virtualPath: tailMatch[2], lineLimit: Math.abs(parseInt(tailMatch[1], 10)), fromEnd: true };
    return { virtualPath: tailMatch[1], lineLimit: 10, fromEnd: true };
  }
  return null;
}

interface HermesPreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string } | Record<string, unknown>;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const input = await readStdin<HermesPreToolUseInput>();
  // Hermes' shell-hook tool name for terminal commands is "terminal".
  if (input.tool_name !== "terminal") return;

  const ti = input.tool_input as { command?: string } | undefined;
  const command = ti?.command;
  if (typeof command !== "string" || command.length === 0) return;
  if (!touchesMemory(command)) return;

  const rewritten = rewritePaths(command);

  const config = loadConfig();
  if (!config) {
    log("no config — falling through to Hermes");
    return;
  }

  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.tableName,
  );

  const grepParams = parseBashGrep(rewritten);
  if (grepParams) {
    try {
      const result = await handleGrepDirect(api, config.tableName, config.sessionsTableName, grepParams);
      if (result === null) return;
      log(`intercepted ${command.slice(0, 80)} → ${result.length} chars from SQL fast-path`);

      const message = [
        result,
        "",
        "(Hivemind: blocked the slow grep against ~/.deeplake/memory/ and ran a single SQL query instead. " +
          "For future recalls, prefer the hivemind_search MCP tool — same accuracy, no terminal round-trip.)",
      ].join("\n");

      process.stdout.write(JSON.stringify({ action: "block", message }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`fast-path failed, falling through: ${msg}`);
      // Silent — Hermes runs the original command via its terminal tool.
    }
    return;
  }

  // Not a grep — try cat / head / tail of a virtual path (e.g. /index.md).
  // Hermes' terminal tool can't read the virtual mount on its own; without
  // this intercept `cat ~/.deeplake/memory/index.md` ENOENTs even though
  // the SessionStart preamble tells the agent to start there.
  const readParams = parseCatHeadTail(rewritten);
  if (!readParams) return;

  try {
    let content = await readVirtualPathContent(api, config.tableName, config.sessionsTableName, readParams.virtualPath);
    if (content === null) {
      log(`fallthrough — readVirtualPathContent returned null for ${readParams.virtualPath}`);
      return;
    }
    if (readParams.lineLimit > 0) {
      const lines = content.split("\n");
      content = readParams.fromEnd ? lines.slice(-readParams.lineLimit).join("\n") : lines.slice(0, readParams.lineLimit).join("\n");
    }
    log(`intercepted ${command.slice(0, 80)} → ${content.length} chars from virtual path`);
    process.stdout.write(JSON.stringify({ action: "block", message: content }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`read fast-path failed, falling through: ${msg}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
