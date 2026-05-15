/**
 * Cursor preToolUse hook (matcher: Shell).
 *
 * Cursor 1.7+ docs: https://cursor.com/docs/agent/hooks
 *
 * When the agent runs a Shell command that targets `~/.deeplake/memory/`,
 * we want to:
 *   - parse the bash command (grep / rg / egrep / fgrep)
 *   - run a single SQL fast-path query against the deeplake `memory` and
 *     `sessions` tables (via the same `searchDeeplakeTables` primitive that
 *     Claude Code, Codex, and OpenClaw use), and
 *   - return an `updated_input` that replaces the original command with
 *     `echo <result>` so Cursor still "runs" something but sees the
 *     pre-computed answer.
 *
 * Result: Cursor recall against `~/.deeplake/memory/` matches Claude Code's
 * accuracy and speed (one SQL query) instead of streaming many readdir/open
 * roundtrips through the virtual filesystem. Lifts Cursor from Tier 3 to
 * Tier 1 in the per-agent accuracy ladder.
 *
 * Input  shape (Cursor): { tool_name, tool_input, tool_use_id, cwd,
 *                           agent_message, conversation_id, hook_event_name,
 *                           workspace_roots, ... }
 * Output shape          : { permission: "allow", updated_input: { command } }
 *                          OR fall through (no JSON, exit 0) to leave the
 *                          command alone for Cursor's own bash to run.
 */

import { randomBytes } from "node:crypto";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { log as _log } from "../../utils/debug.js";
import { parseBashGrep, handleGrepDirect } from "../grep-direct.js";
import { touchesMemory, rewritePaths } from "../memory-path-utils.js";
import { readVirtualPathContent } from "../virtual-table-query.js";
const log = (msg: string) => _log("cursor-pre-tool-use", msg);

/**
 * Pick a heredoc terminator that's guaranteed not to appear on any line of
 * the payload. A fixed terminator (e.g. `__HIVEMIND_RESULT__`) is unsafe
 * because the captured memory content is user-controllable: a stored
 * session message whose body happens to be that exact line would close the
 * heredoc early, leaving the rest of the content for the shell to execute.
 * 24 random bytes makes a collision astronomically unlikely, and the
 * regex-anchored check on the payload guarantees safety even if it occurs.
 */
function pickHeredocTerminator(payload: string): string {
  for (let attempt = 0; attempt < 4; attempt++) {
    const marker = `__HIVEMIND_RESULT_${randomBytes(24).toString("hex")}__`;
    if (!new RegExp(`^${marker}$`, "m").test(payload)) return marker;
  }
  // Astronomically unreachable; tail-call to a longer marker if it ever hits.
  return `__HIVEMIND_RESULT_${randomBytes(48).toString("hex")}__`;
}

/**
 * Match a bash `cat <path>` / `head [-n N] <path>` / `tail [-n N] <path>`
 * command and return the rewritten virtual path + line-limit hints. Mirror
 * of the parsing in src/hooks/pre-tool-use.ts for the Read/Bash branch —
 * pulled in here so Cursor can serve /index.md and other virtual paths
 * instead of letting `cat ~/.deeplake/memory/index.md` ENOENT.
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

interface CursorShellToolInput {
  command?: string;
}

interface CursorPreToolUseInput {
  tool_name?: string;
  tool_input?: CursorShellToolInput | Record<string, unknown>;
  tool_use_id?: string;
  cwd?: string;
  conversation_id?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
}

async function main(): Promise<void> {
  const input = await readStdin<CursorPreToolUseInput>();
  if (input.tool_name !== "Shell") return; // only intercept Shell, not Read/Write/MCP

  const command = (input.tool_input as CursorShellToolInput | undefined)?.command;
  if (typeof command !== "string" || command.length === 0) return;
  if (!touchesMemory(command)) return; // not aimed at our mount — let Cursor run it

  // Translate host paths (~/.deeplake/memory, $HOME/..., absolute) to the
  // virtual mount root "/" before parsing — same step Claude / Codex run.
  const rewritten = rewritePaths(command);

  const config = loadConfig();
  if (!config) {
    log("no config — falling through to Cursor's bash");
    return;
  }

  const api = new DeeplakeApi(
    config.token,
    config.apiUrl,
    config.orgId,
    config.workspaceId,
    config.tableName,
  );

  const respondWith = (result: string, label: string): void => {
    const terminator = pickHeredocTerminator(result);
    const echoCmd = `cat <<'${terminator}'\n${result}\n${terminator}`;
    process.stdout.write(JSON.stringify({
      permission: "allow",
      updated_input: { command: echoCmd },
      agent_message: `[Hivemind direct] ${label}`,
    }));
  };

  const grepParams = parseBashGrep(rewritten);
  if (grepParams) {
    try {
      const result = await handleGrepDirect(api, config.tableName, config.sessionsTableName, grepParams);
      if (result !== null) {
        log(`intercepted ${command.slice(0, 80)} → ${result.length} chars from SQL fast-path`);
        respondWith(result, grepParams.pattern);
        return;
      }
      log(`fallthrough — handleGrepDirect returned null for "${grepParams.pattern}"`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`fast-path failed, falling through: ${msg}`);
    }
    return;
  }

  // Not a grep — try cat / head / tail of a virtual path (e.g. /index.md).
  // CC routes these through readVirtualPathContents; without the equivalent
  // intercept here, `cat ~/.deeplake/memory/index.md` from a Cursor shell
  // ENOENTs and the agent never sees the index we synthesize on the fly.
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
    const label = readParams.lineLimit > 0
      ? `${readParams.fromEnd ? "tail" : "head"} -${readParams.lineLimit} ${readParams.virtualPath}`
      : `cat ${readParams.virtualPath}`;
    log(`intercepted ${command.slice(0, 80)} → ${content.length} chars from virtual path`);
    respondWith(content, label);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`read fast-path failed, falling through: ${msg}`);
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
