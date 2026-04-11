#!/usr/bin/env node

/**
 * Codex PreToolUse hook — intercepts Bash commands targeting ~/.deeplake/memory/.
 *
 * Strategy: "block + inject"
 * Codex 0.118.0 doesn't parse JSON hook output, but supports:
 *   - stderr + exit code 2 → blocks the command, stderr becomes model feedback
 *   - plain text stdout → adds context (command still runs)
 *   - exit 0 + no output → pass through
 *
 * When we detect a memory-targeting command, we:
 * 1. Fetch the real content from the cloud (SQL or virtual shell)
 * 2. Block the command (exit 2) and return the content via stderr
 * 3. The model receives the cloud content as if the command ran
 *
 * Codex input:  { session_id, tool_name, tool_use_id, tool_input: { command }, cwd, ... }
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { sqlStr, sqlLike } from "../../utils/sql.js";

import { log as _log } from "../../utils/debug.js";
const log = (msg: string) => _log("codex-pre", msg);

const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
const TILDE_PATH = "~/.deeplake/memory";
const HOME_VAR_PATH = "$HOME/.deeplake/memory";

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const SHELL_BUNDLE = existsSync(join(__bundleDir, "shell", "deeplake-shell.js"))
  ? join(__bundleDir, "shell", "deeplake-shell.js")
  : join(__bundleDir, "..", "shell", "deeplake-shell.js");

// Safe builtins that can run against the virtual FS
const SAFE_BUILTINS = new Set([
  "cat", "ls", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod",
  "stat", "readlink", "du", "tree", "file",
  "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "tac", "rev", "nl", "fold", "expand", "unexpand",
  "paste", "join", "comm", "column", "diff", "strings", "split",
  "find", "xargs", "which",
  "jq", "yq", "xan", "base64", "od",
  "tar", "gzip", "gunzip", "zcat",
  "md5sum", "sha1sum", "sha256sum",
  "echo", "printf", "tee",
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

function isSafe(cmd: string): boolean {
  // Reject command/process substitution before checking tokens
  if (/\$\(|`|<\(/.test(cmd)) return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\|/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

interface CodexPreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: { command: string };
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
}

function touchesMemory(cmd: string): boolean {
  return cmd.includes(MEMORY_PATH) || cmd.includes(TILDE_PATH) || cmd.includes(HOME_VAR_PATH);
}

function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}

/** Block the command and return content to the model via stderr + exit 2. */
function blockWithContent(content: string): never {
  process.stderr.write(content);
  process.exit(2);
}

/** Block the command with an error/denial message. */
function blockWithDeny(reason: string): never {
  process.stderr.write(reason);
  process.exit(2);
}

/** Run a command through the virtual shell and return the output. */
function runVirtualShell(cmd: string): string {
  try {
    return execFileSync("node", [SHELL_BUNDLE, "-c", cmd], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],  // capture stderr instead of inheriting
    }).trim();
  } catch (e: any) {
    log(`virtual shell failed: ${e.message}`);
    return "";
  }
}

async function main(): Promise<void> {
  const input = await readStdin<CodexPreToolUseInput>();
  const cmd = input.tool_input?.command ?? "";
  log(`hook fired: cmd=${cmd}`);

  if (!touchesMemory(cmd)) return;

  const rewritten = rewritePaths(cmd);

  if (!isSafe(rewritten)) {
    log(`unsafe command blocked: ${rewritten}`);
    blockWithDeny("This command is not supported for memory operations. Use standard commands like cat, ls, grep, echo instead.");
  }

  // ── Fast path: handle grep and cat directly via SQL ──
  const config = loadConfig();
  if (config) {
    const table = process.env["DEEPLAKE_TABLE"] ?? "memory";
    const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, table);

    try {
      // Detect: cat <path>
      const catMatch = rewritten.match(/^cat\s+(\S+)$/);
      if (catMatch) {
        const virtualPath = catMatch[1];
        log(`direct read: ${virtualPath}`);
        const rows = await api.query(
          `SELECT summary FROM "${table}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`
        );
        if (rows.length > 0 && rows[0]["summary"]) {
          blockWithContent(rows[0]["summary"] as string);
        }
      }

      // Detect: ls [-alh...] <path>
      const lsMatch = rewritten.match(/^ls\s+(?:-[a-zA-Z]+\s+)*(\S+)?\s*$/);
      if (lsMatch) {
        const dir = (lsMatch[1] ?? "/").replace(/\/+$/, "") || "/";
        const isLong = /\s-[a-zA-Z]*l/.test(rewritten);
        log(`direct ls: ${dir}`);
        const rows = await api.query(
          `SELECT path, size_bytes FROM "${table}" WHERE path LIKE '${sqlLike(dir === "/" ? "" : dir)}/%' ORDER BY path`
        );
        // Build directory listing from paths
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
        if (entries.size > 0) {
          const lines: string[] = [];
          for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (isLong) {
              const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
              const size = info.isDir ? "0" : String(info.size).padStart(6);
              lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
            } else {
              lines.push(name + (info.isDir ? "/" : ""));
            }
          }
          blockWithContent(lines.join("\n"));
        } else {
          blockWithContent(`ls: cannot access '${dir}': No such file or directory`);
        }
      }

      // Detect: grep [-ri] <pattern> <path>
      const grepMatch = rewritten.match(/^grep\s+(?:-[a-zA-Z]+\s+)*(?:'([^']*)'|"([^"]*)"|(\S+))\s+(\S+)/);
      if (grepMatch) {
        const pattern = grepMatch[1] ?? grepMatch[2] ?? grepMatch[3];
        const ignoreCase = /\s-[a-zA-Z]*i/.test(rewritten);
        log(`direct grep: ${pattern}`);
        const rows = await api.query(
          `SELECT path, summary FROM "${table}" WHERE summary ${ignoreCase ? "ILIKE" : "LIKE"} '%${sqlLike(pattern)}%' LIMIT 5`
        );
        if (rows.length > 0) {
          const allResults: string[] = [];
          const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
          for (const row of rows) {
            const p = row["path"] as string;
            const text = row["summary"] as string;
            if (!text) continue;
            const matches = text.split("\n")
              .filter(line => re.test(line))
              .slice(0, 5)
              .map(line => `${p}:${line.slice(0, 300)}`);
            allResults.push(...matches);
          }
          const results = allResults.join("\n");
          blockWithContent(results || "(no matches)");
        }
      }
    } catch (e: any) {
      log(`direct query failed, falling back to shell: ${e.message}`);
    }
  }

  // ── Fallback: run through virtual shell, return output ──
  log(`intercepted → running via virtual shell: ${rewritten}`);
  const result = runVirtualShell(rewritten);

  if (result) {
    blockWithContent(result);
  } else {
    blockWithContent("[Deeplake Memory] Command returned empty or the file does not exist in cloud storage.");
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
