#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr, sqlLike } from "../utils/sql.js";

import { log as _log } from "../utils/debug.js";
const log = (msg: string) => _log("pre", msg);

const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
const TILDE_PATH = "~/.deeplake/memory";
const HOME_VAR_PATH = "$HOME/.deeplake/memory";

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const SHELL_BUNDLE = existsSync(join(__bundleDir, "shell", "deeplake-shell.js"))
  ? join(__bundleDir, "shell", "deeplake-shell.js")
  : join(__bundleDir, "..", "shell", "deeplake-shell.js");

// All commands supported by just-bash + shell control flow
const SAFE_BUILTINS = new Set([
  // filesystem
  "cat", "ls", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod",
  "stat", "readlink", "du", "tree", "file",
  // text processing
  "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "tac", "rev", "nl", "fold", "expand", "unexpand",
  "paste", "join", "comm", "column", "diff", "strings", "split",
  // search
  "find", "xargs", "which",
  // data formats
  "jq", "yq", "xan", "base64", "od",
  // archives
  "tar", "gzip", "gunzip", "zcat",
  // hashing
  "md5sum", "sha1sum", "sha256sum",
  // output/io
  "echo", "printf", "tee", "cat",
  // path/env
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  // misc
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  // shell control flow
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

function isSafe(cmd: string): boolean {
  // Reject command/process substitution before checking tokens
  if (/\$\(|`|<\(/.test(cmd)) return false;
  // Strip quoted strings before splitting on pipes — prevents splitting
  // inside jq expressions like 'select(.type) | .content'
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\||\n/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

function touchesMemory(p: string): boolean {
  return p.includes(MEMORY_PATH) || p.includes(TILDE_PATH) || p.includes(HOME_VAR_PATH);
}

function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}

function getShellCommand(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Grep": {
      const p = toolInput.path as string | undefined;
      if (p && touchesMemory(p)) {
        const pattern = toolInput.pattern as string ?? "";
        const flags: string[] = ["-r"];
        if (toolInput["-i"]) flags.push("-i");
        if (toolInput["-n"]) flags.push("-n");
        return `grep ${flags.join(" ")} '${pattern}' /`;
      }
      break;
    }
    case "Read": {
      const fp = toolInput.file_path as string | undefined;
      if (fp && touchesMemory(fp)) {
        const virtualPath = rewritePaths(fp) || "/";
        return `cat ${virtualPath}`;
      }
      break;
    }
    case "Bash": {
      const cmd = toolInput.command as string | undefined;
      if (!cmd || !touchesMemory(cmd)) break;
      {
        const rewritten = rewritePaths(cmd);
        if (!isSafe(rewritten)) {
          log(`unsafe command blocked: ${rewritten}`);
          return null;
        }
        return rewritten;
      }
      break;
    }
    case "Glob": {
      const p = toolInput.path as string | undefined;
      if (p && touchesMemory(p)) {
        return `ls /`;
      }
      break;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const input = await readStdin<PreToolUseInput>();
  log(`hook fired: tool=${input.tool_name} input=${JSON.stringify(input.tool_input)}`);

  const cmd = (input.tool_input.command as string) ?? "";
  const shellCmd = getShellCommand(input.tool_name, input.tool_input);

  // Also check non-Bash tools (Read/Write/Edit/Glob/Grep) that touch memory but didn't get a shellCmd
  const toolPath = (input.tool_input.file_path ?? input.tool_input.path ?? "") as string;
  if (!shellCmd && (touchesMemory(cmd) || touchesMemory(toolPath))) {
    // Instead of denying (which triggers alarm loops in Claude Code), return
    // an "allow" with guidance that tells the agent to retry with bash.
    // Uses stdout so the agent sees it as output (not a fatal error), but
    // prefixed with [RETRY] to signal it should try again differently.
    const guidance = "[RETRY REQUIRED] The command you tried is not available for ~/.deeplake/memory/. " +
      "This virtual filesystem only supports bash builtins: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find, etc. " +
      "python, python3, node, and curl are NOT available. " +
      "You MUST rewrite your command using only the bash tools listed above and try again. " +
      "For example, to parse JSON use: cat file.json | jq '.key'. To count keys: cat file.json | jq 'keys | length'.";
    log(`unsupported command, returning guidance: ${cmd}`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          command: `echo ${JSON.stringify(guidance)}`,
          description: "[DeepLake] unsupported command — rewrite using bash builtins",
        },
      },
    }));
    return;
  }

  if (!shellCmd) return;

  // ── Fast path: handle Read and Grep directly via SQL (no shell spawn) ──
  const config = loadConfig();
  if (config && (input.tool_name === "Read" || input.tool_name === "Grep")) {
    const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);

    try {
      if (input.tool_name === "Read") {
        const virtualPath = rewritePaths((input.tool_input.file_path as string) ?? "");
        log(`direct read: ${virtualPath}`);
        // Try memory table first (summaries)
        const rows = await api.query(
          `SELECT summary FROM "${table}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`
        );
        if (rows.length > 0 && rows[0]["summary"]) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                command: `echo ${JSON.stringify(rows[0]["summary"])}`,
                description: `[DeepLake direct] cat ${virtualPath}`,
              },
            },
          }));
          return;
        }
        // Try sessions table (raw data) — for paths like /sessions/conv_N_session_M.json
        if (virtualPath.startsWith("/sessions/")) {
          const sessionsTable = process.env["DEEPLAKE_SESSIONS_TABLE"] ?? "sessions";
          try {
            const sessionRows = await api.query(
              `SELECT message::text AS content FROM "${sessionsTable}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`
            );
            if (sessionRows.length > 0 && sessionRows[0]["content"]) {
              console.log(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  updatedInput: {
                    command: `echo ${JSON.stringify(sessionRows[0]["content"])}`,
                    description: `[DeepLake direct] cat ${virtualPath}`,
                  },
                },
              }));
              return;
            }
          } catch { /* fall through to shell */ }
        }
      } else if (input.tool_name === "Grep") {
        const pattern = (input.tool_input.pattern as string) ?? "";
        const ignoreCase = !!input.tool_input["-i"];
        log(`direct grep: ${pattern}`);
        const likeOp = ignoreCase ? "ILIKE" : "LIKE";
        const escapedPattern = sqlLike(pattern);
        const sessionsTable = process.env["DEEPLAKE_SESSIONS_TABLE"] ?? "sessions";

        // Search both memory (summaries) and sessions (raw data) in parallel
        const [memoryRows, sessionRows] = await Promise.all([
          api.query(
            `SELECT path, summary FROM "${table}" WHERE summary ${likeOp} '%${escapedPattern}%' LIMIT 5`
          ).catch(() => [] as Record<string, unknown>[]),
          api.query(
            `SELECT path, message::text AS content FROM "${sessionsTable}" WHERE message::text ${likeOp} '%${escapedPattern}%' LIMIT 3`
          ).catch(() => [] as Record<string, unknown>[]),
        ]);

        if (memoryRows.length > 0 || sessionRows.length > 0) {
          const allResults: string[] = [];
          const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
          for (const row of memoryRows) {
            const p = row["path"] as string;
            const text = row["summary"] as string;
            if (!text) continue;
            const matches = text.split("\n")
              .filter(line => re.test(line))
              .slice(0, 5)
              .map(line => `${p}:${line.slice(0, 300)}`);
            allResults.push(...matches);
          }
          for (const row of sessionRows) {
            const p = row["path"] as string;
            const text = row["content"] as string;
            if (!text) continue;
            // Extract matching dialogue turns from session JSON
            const matches = text.split(/(?:"text"\s*:\s*")/g)
              .filter(chunk => re.test(chunk))
              .slice(0, 3)
              .map(chunk => `${p}:${chunk.slice(0, 300).replace(/\\n/g, " ")}`);
            allResults.push(...matches);
          }
          const results = allResults.join("\n");
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                command: `echo ${JSON.stringify(results || "(no matches)")}`,
                description: `[DeepLake direct] grep ${pattern}`,
              },
            },
          }));
          return;
        }
      }
    } catch (e: any) {
      log(`direct query failed, falling back to shell: ${e.message}`);
    }
  }

  // ── Slow path: rewrite to virtual shell (for Bash, Glob, or when direct fails) ──
  log(`intercepted → rewriting to shell: ${shellCmd}`);

  const rewrittenCommand = `node "${SHELL_BUNDLE}" -c "${shellCmd.replace(/"/g, '\\"')}"`;

  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        command: rewrittenCommand,
        description: `[DeepLake] ${shellCmd}`,
      },
    },
  };

  log(`rewritten: ${rewrittenCommand}`);
  console.log(JSON.stringify(output));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
