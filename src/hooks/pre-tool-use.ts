#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
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
      if (cmd && touchesMemory(cmd)) {
        const rewritten = rewritePaths(cmd);
        if (!isSafe(rewritten)) {
          log(`unsafe command blocked: ${rewritten.slice(0, 100)}`);
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
  log(`hook fired: tool=${input.tool_name} input=${JSON.stringify(input.tool_input).slice(0, 200)}`);

  const shellCmd = getShellCommand(input.tool_name, input.tool_input);
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
