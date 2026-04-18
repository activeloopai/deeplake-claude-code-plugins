#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike } from "../utils/sql.js";
import { type GrepParams, parseBashGrep, handleGrepDirect } from "./grep-direct.js";
import {
  findVirtualPaths,
  listVirtualPathRows,
  readVirtualPathContent,
} from "./virtual-table-query.js";

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

// ── Output helper ────────────────────────────────────────────────────────────

function emitResult(command: string, description: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command, description },
    },
  }));
}

// ── Grep parameter extraction (Claude Code specific) ─────────────────────────

/** Extract grep parameters from Grep tool input or Bash grep command. */
function extractGrepParams(
  toolName: string,
  toolInput: Record<string, unknown>,
  shellCmd: string,
): GrepParams | null {
  if (toolName === "Grep") {
    const outputMode = (toolInput.output_mode as string) ?? "files_with_matches";
    return {
      pattern: (toolInput.pattern as string) ?? "",
      targetPath: rewritePaths((toolInput.path as string) ?? "") || "/",
      ignoreCase: !!toolInput["-i"],
      wordMatch: false,
      filesOnly: outputMode === "files_with_matches",
      countOnly: outputMode === "count",
      lineNumber: !!toolInput["-n"],
      invertMatch: false,
      fixedString: false,
    };
  }
  if (toolName === "Bash") return parseBashGrep(shellCmd);
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
  if (config) {
    const table = process.env["HIVEMIND_TABLE"] ?? "memory";
    const sessionsTable = process.env["HIVEMIND_SESSIONS_TABLE"] ?? "sessions";
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);

    try {
      // ── Grep (Grep tool or Bash grep) — single SQL query ──
      const grepParams = extractGrepParams(input.tool_name, input.tool_input, shellCmd);
      if (grepParams) {
        log(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
        const result = await handleGrepDirect(api, table, sessionsTable, grepParams);
        if (result !== null) {
          emitResult(`echo ${JSON.stringify(result)}`, `[DeepLake direct] grep ${grepParams.pattern}`);
          return;
        }
      }

      // ── Read file: Read tool, or Bash cat/head/tail ──
      {
        let virtualPath: string | null = null;
        let lineLimit = 0; // 0 = all lines
        let fromEnd = false; // true = tail

        if (input.tool_name === "Read") {
          virtualPath = rewritePaths((input.tool_input.file_path as string) ?? "");
        } else if (input.tool_name === "Bash") {
          // cat <file> [2>...] [| grep ... | head -N]  or  [| head -N]
          // Strip stderr redirect (2>/dev/null, 2>&1, etc.) and optional grep -v pipe
          const catCmd = shellCmd.replace(/\s+2>\S+/g, "").trim();
          const catPipeHead = catCmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
          if (catPipeHead) { virtualPath = catPipeHead[1]; lineLimit = Math.abs(parseInt(catPipeHead[2], 10)); }
          // cat <file>
          if (!virtualPath) {
            const catMatch = catCmd.match(/^cat\s+(\S+)\s*$/);
            if (catMatch) virtualPath = catMatch[1];
          }
          // head [-n] N <file>
          if (!virtualPath) {
            const headMatch = shellCmd.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ??
                              shellCmd.match(/^head\s+(\S+)\s*$/);
            if (headMatch) {
              if (headMatch[2]) { virtualPath = headMatch[2]; lineLimit = Math.abs(parseInt(headMatch[1], 10)); }
              else { virtualPath = headMatch[1]; lineLimit = 10; }
            }
          }
          // tail [-n] N <file>
          if (!virtualPath) {
            const tailMatch = shellCmd.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ??
                              shellCmd.match(/^tail\s+(\S+)\s*$/);
            if (tailMatch) {
              fromEnd = true;
              if (tailMatch[2]) { virtualPath = tailMatch[2]; lineLimit = Math.abs(parseInt(tailMatch[1], 10)); }
              else { virtualPath = tailMatch[1]; lineLimit = 10; }
            }
          }
          // wc -l <file>
          if (!virtualPath) {
            const wcMatch = shellCmd.match(/^wc\s+-l\s+(\S+)\s*$/);
            if (wcMatch) { virtualPath = wcMatch[1]; lineLimit = -1; } // -1 = count mode
          }
        }

        if (virtualPath && !virtualPath.endsWith("/")) {
          log(`direct read: ${virtualPath}`);
          let content = await readVirtualPathContent(api, table, sessionsTable, virtualPath);
          if (content === null && virtualPath === "/index.md") {
            // Virtual index — generate from metadata
            const idxRows = await api.query(
              `SELECT path, project, description, creation_date FROM "${table}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`
            );
            const lines = ["# Memory Index", "", `${idxRows.length} sessions:`, ""];
            for (const r of idxRows) {
              const p = r["path"] as string;
              const proj = r["project"] as string || "";
              const desc = (r["description"] as string || "").slice(0, 120);
              const date = (r["creation_date"] as string || "").slice(0, 10);
              lines.push(`- [${p}](${p}) ${date} ${proj ? `[${proj}]` : ""} ${desc}`);
            }
            content = lines.join("\n");
          }

          if (content !== null) {
            if (lineLimit === -1) {
              const count = content.split("\n").length;
              emitResult(`echo ${JSON.stringify(`${count} ${virtualPath}`)}`, `[DeepLake direct] wc -l ${virtualPath}`);
              return;
            }
            if (lineLimit > 0) {
              const lines = content.split("\n");
              content = fromEnd ? lines.slice(-lineLimit).join("\n") : lines.slice(0, lineLimit).join("\n");
            }
            const label = lineLimit > 0 ? (fromEnd ? `tail -${lineLimit}` : `head -${lineLimit}`) : "cat";
            emitResult(`echo ${JSON.stringify(content)}`, `[DeepLake direct] ${label} ${virtualPath}`);
            return;
          }
        }
      }

      // ── ls: Bash ls or Glob tool ──
      {
        let lsDir: string | null = null;
        let longFormat = false;

        if (input.tool_name === "Glob") {
          lsDir = rewritePaths((input.tool_input.path as string) ?? "") || "/";
        } else if (input.tool_name === "Bash") {
          const lsMatch = shellCmd.match(/^ls\s+(?:-([a-zA-Z]+)\s+)?(\S+)?\s*$/);
          if (lsMatch) {
            lsDir = lsMatch[2] ?? "/";
            longFormat = (lsMatch[1] ?? "").includes("l");
          }
        }

        if (lsDir) {
          const dir = lsDir.replace(/\/+$/, "") || "/";
          log(`direct ls: ${dir}`);
          const rows = await listVirtualPathRows(api, table, sessionsTable, dir);
          const entries = new Map<string, { isDir: boolean; size: number }>();
          const prefix = dir === "/" ? "/" : dir + "/";
          for (const row of rows) {
            const p = row["path"] as string;
            if (!p.startsWith(prefix) && dir !== "/") continue;
            const rest = dir === "/" ? p.slice(1) : p.slice(prefix.length);
            const slash = rest.indexOf("/");
            const name = slash === -1 ? rest : rest.slice(0, slash);
            if (!name) continue;
            const existing = entries.get(name);
            if (slash !== -1) {
              if (!existing) entries.set(name, { isDir: true, size: 0 });
            } else {
              entries.set(name, { isDir: false, size: (row["size_bytes"] as number) ?? 0 });
            }
          }
          const lines: string[] = [];
          for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (longFormat) {
              const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
              const size = String(info.isDir ? 0 : info.size).padStart(6);
              lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
            } else {
              lines.push(name + (info.isDir ? "/" : ""));
            }
          }
          emitResult(`echo ${JSON.stringify(lines.join("\n") || "(empty directory)")}`, `[DeepLake direct] ls ${dir}`);
          return;
        }
      }

      // ── find <dir> -name '<pattern>' ──
      if (input.tool_name === "Bash") {
        const findMatch = shellCmd.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/);
        if (findMatch) {
          const dir = findMatch[1].replace(/\/+$/, "") || "/";
          const namePattern = sqlLike(findMatch[2]).replace(/\*/g, "%").replace(/\?/g, "_");
          log(`direct find: ${dir} -name '${findMatch[2]}'`);
          const paths = await findVirtualPaths(api, table, sessionsTable, dir, namePattern);
          let result = paths.join("\n") || "";
          // Handle piped wc -l
          if (/\|\s*wc\s+-l\s*$/.test(shellCmd)) {
            result = String(paths.length);
          }
          emitResult(`echo ${JSON.stringify(result || "(no matches)")}`, `[DeepLake direct] find ${dir}`);
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
