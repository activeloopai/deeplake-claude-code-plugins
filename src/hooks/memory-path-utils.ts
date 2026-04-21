import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
export const TILDE_PATH = "~/.deeplake/memory";
export const HOME_VAR_PATH = "$HOME/.deeplake/memory";

export const SAFE_BUILTINS = new Set([
  "cat", "ls", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod",
  "stat", "readlink", "du", "tree", "file",
  "grep", "egrep", "fgrep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "tac", "rev", "nl", "fold", "expand", "unexpand",
  "paste", "join", "comm", "column", "diff", "strings", "split",
  "find", "xargs", "which",
  "jq", "yq", "xan", "base64", "od",
  "tar", "gzip", "gunzip", "zcat",
  "md5sum", "sha1sum", "sha256sum",
  "psql",
  "echo", "printf", "tee",
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

function splitSafeStages(cmd: string): string[] | null {
  const stages: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === "\"") {
        escaped = true;
      }
      continue;
    }

    if (ch === "\\" && i + 1 < cmd.length) {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      current += ch;
      continue;
    }

    const twoChar = cmd.slice(i, i + 2);
    if (twoChar === "&&" || twoChar === "||") {
      if (current.trim()) stages.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      if (current.trim()) stages.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (quote || escaped) return null;
  if (current.trim()) stages.push(current.trim());
  return stages;
}

export function isSafe(cmd: string): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = splitSafeStages(stripped);
  if (!stages) return false;
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

export function touchesMemory(p: string): boolean {
  return p.includes(MEMORY_PATH) || p.includes(TILDE_PATH) || p.includes(HOME_VAR_PATH);
}

export function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}
