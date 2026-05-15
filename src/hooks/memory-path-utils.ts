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
  "echo", "printf", "tee",
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

export function isSafe(cmd: string): boolean {
  if (/\$\(|`|<\(/.test(cmd)) return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const stages = stripped.split(/\||;|&&|\|\||\n/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

// Sub-agent CLIs that take a prompt string as an argument and never touch the
// memory mount themselves. When a pipe-stage that contains a memory-path
// substring starts with one of these, we treat the path as part of the
// prompt argument (e.g. `claude -p 'use ~/.deeplake/memory/'`) and let it
// through. Interpreters like python/node/curl/ruby are deliberately NOT in
// this list — they will actually try to read the path and need guidance.
const AGENT_COMMANDS = new Set([
  "claude", "codex", "cursor-agent", "hermes", "pi", "openclaw",
]);

/**
 * Quote-aware split into shell pipeline stages. The naive
 * `p.split(/\||;|&&/)` treats every literal separator as a real stage
 * boundary, including separators inside quoted prompt strings — so a
 * command like `claude -p "first; check ~/.deeplake/memory/"` would
 * manufacture a phantom stage starting with `check`, and our agent-CLI
 * allowlist would miss it and false-positive intercept. This walker tracks
 * single/double-quote state and a one-char backslash escape so only
 * unquoted separators split.
 */
function splitShellStages(p: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (quote === '"' && ch === "\\") { cur += ch; escaped = true; continue; }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch as "'" | '"'; cur += ch; continue; }
    if (ch === ";" || ch === "\n") { out.push(cur); cur = ""; continue; }
    if (ch === "|" || (ch === "&" && p[i + 1] === "&")) {
      out.push(cur);
      cur = "";
      if (ch === "&") i++; // skip second `&` of `&&`
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function touchesMemory(p: string): boolean {
  // Fast reject: no memory-path substring anywhere → not our concern.
  if (!p.includes(MEMORY_PATH) && !p.includes(TILDE_PATH) && !p.includes(HOME_VAR_PATH)) {
    return false;
  }
  // Find a pipe-stage that actually contains a memory-path substring. If its
  // first token is a sub-agent CLI, the path is in a prompt arg, not a file
  // arg, and we pass through. Any other first token (cat/grep/python/curl/
  // node/etc.) means we should intercept — either to route to the virtual
  // mount, or to surface the "unsafe interpreter" guidance message.
  for (const stage of splitShellStages(p)) {
    if (!stage.includes(MEMORY_PATH) && !stage.includes(TILDE_PATH) && !stage.includes(HOME_VAR_PATH)) continue;
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (!AGENT_COMMANDS.has(firstToken)) return true;
  }
  return false;
}

export function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}
