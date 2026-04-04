#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readStdin } from "../utils/stdin.js";

const LOG = join(homedir(), ".deeplake", "hook-debug.log");
function log(msg: string) {
  appendFileSync(LOG, `${new Date().toISOString()} [pre] ${msg}\n`);
}

const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
const TILDE_PATH = "~/.deeplake/memory";

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const SHELL_BUNDLE = existsSync(join(__bundleDir, "shell", "deeplake-shell.js"))
  ? join(__bundleDir, "shell", "deeplake-shell.js")
  : join(__bundleDir, "..", "shell", "deeplake-shell.js");

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

function getShellCommand(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Grep": {
      const p = toolInput.path as string | undefined;
      if (p && (p.startsWith(MEMORY_PATH) || p.startsWith(TILDE_PATH))) {
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
      if (fp && (fp.startsWith(MEMORY_PATH) || fp.startsWith(TILDE_PATH))) {
        const virtualPath = fp.replace(MEMORY_PATH, "").replace(homedir() + "/.deeplake/memory", "") || "/";
        return `cat ${virtualPath}`;
      }
      break;
    }
    case "Bash": {
      const cmd = toolInput.command as string | undefined;
      if (cmd && (cmd.includes(MEMORY_PATH) || cmd.includes(TILDE_PATH))) {
        return cmd
          .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
          .replace(/~\/.deeplake\/memory\/?/g, "/");
      }
      break;
    }
    case "Glob": {
      const p = toolInput.path as string | undefined;
      if (p && (p.startsWith(MEMORY_PATH) || p.startsWith(TILDE_PATH))) {
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
