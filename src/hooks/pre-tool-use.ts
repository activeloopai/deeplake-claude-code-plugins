#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlStr } from "../utils/sql.js";

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
  // Strip quoted strings before splitting on pipes — prevents splitting
  // inside jq expressions like 'select(.type) | .content'
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\|/);
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
      // Let deeplake CLI commands pass through to real bash (install, mount, login, etc.)
      if (/\bdeeplake\s+(mount|login|unmount|status)\b/.test(cmd) || cmd.includes("deeplake.ai/install")) break;
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

  // Let deeplake CLI commands (install, mount, login) pass through to real bash
  if (!shellCmd && touchesMemory(cmd) && (/\bdeeplake\s+(mount|login|unmount|status)\b/.test(cmd) || cmd.includes("deeplake.ai/install"))) {
    log(`deeplake CLI command — passing through to real bash`);
    return;
  }

  if (!shellCmd && touchesMemory(cmd)) {
    // Check if deeplake CLI is installed — if yes, let it run on real FUSE mount
    let cliInstalled = false;
    try {
      execFileSync("which", ["deeplake"], { stdio: "ignore", timeout: 2000 });
      cliInstalled = true;
    } catch {
      // Also check common install paths
      const paths = ["/usr/local/bin/deeplake", join(homedir(), ".local", "bin", "deeplake"), join(homedir(), ".deeplake", "bin", "deeplake")];
      cliInstalled = paths.some(p => existsSync(p));
    }

    if (cliInstalled) {
      // Check if FUSE mount is active
      const mountActive = existsSync(join(MEMORY_PATH, ".deeplake"));
      if (mountActive) {
        log(`unsafe, CLI installed + mounted — passing through to real bash`);
        return;
      }
      log(`unsafe, CLI installed but not mounted → suggesting mount`);
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "The Deeplake CLI is installed but the memory filesystem is not mounted.",
          additionalContext: "Ask the user: 'The Deeplake memory filesystem needs to be mounted. Shall I mount it?' If they agree, run: deeplake mount ~/.deeplake/memory — then retry the original command. If mount fails, report the error and stop.",
        },
      }));
      return;
    }

    log(`unsafe, CLI not installed → suggesting install`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "This command requires the Deeplake CLI with FUSE mount support.",
        additionalContext: "Ask the user: 'This command needs the Deeplake CLI. Shall I install it?' If they agree, run: curl -fsSL https://deeplake.ai/install.sh | bash && deeplake mount ~/.deeplake/memory — then retry the original command. If they decline, rewrite using safe builtins (cat, grep, jq, head, tail). If install fails (FUSE not supported, Windows, permission error), report the error and stop.",
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
        const rows = await api.query(
          `SELECT content_text FROM "${table}" WHERE path = '${sqlStr(virtualPath)}' LIMIT 1`
        );
        if (rows.length > 0 && rows[0]["content_text"]) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                command: `echo ${JSON.stringify(rows[0]["content_text"])}`,
                description: `[DeepLake direct] cat ${virtualPath}`,
              },
            },
          }));
          return;
        }
      } else if (input.tool_name === "Grep") {
        const pattern = (input.tool_input.pattern as string) ?? "";
        const ignoreCase = !!input.tool_input["-i"];
        log(`direct grep: ${pattern}`);
        // Single query: fetch path + content together (avoids N+1 round-trips)
        const rows = await api.query(
          `SELECT path, content_text FROM "${table}" WHERE content_text ${ignoreCase ? "ILIKE" : "LIKE"} '%${sqlStr(pattern)}%' LIMIT 5`
        );
        if (rows.length > 0) {
          const allResults: string[] = [];
          const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
          for (const row of rows) {
            const p = row["path"] as string;
            const text = row["content_text"] as string;
            if (!text) continue;
            const matches = text.split("\n")
              .filter(line => re.test(line))
              .slice(0, 5)
              .map(line => `${p}:${line.slice(0, 300)}`);
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
        description: `[DeepLake virtual FS] ${shellCmd}`,
      },
    },
  };

  log(`rewritten: ${rewrittenCommand}`);
  console.log(JSON.stringify(output));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
