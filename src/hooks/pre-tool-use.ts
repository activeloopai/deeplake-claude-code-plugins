#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../utils/stdin.js";

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
      log(`unsafe but CLI installed — passing through to real bash`);
      return; // Let real bash + FUSE handle it
    }

    log(`unsafe → denying, suggesting CLI install`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "This command requires the Deeplake CLI with FUSE mount support.",
        additionalContext: "Ask the user if they want to install the Deeplake CLI. Do NOT silently rewrite or skip. If they agree, run: curl -fsSL https://deeplake.ai/install.sh | bash && deeplake mount ~/.deeplake/memory — then retry the original command. If they decline, rewrite using safe builtins (cat, grep, jq, head, tail). If install fails (FUSE not supported, Windows, permission error), report the error and stop.",
      },
    }));
    return;
  }

  if (!shellCmd) return;

  log(`intercepted → rewriting to shell: ${shellCmd}`);

  // Rewrite the tool input to run through the virtual shell instead
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
