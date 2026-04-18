#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { sqlLike } from "../utils/sql.js";
import { log as _log } from "../utils/debug.js";
import { isDirectRun } from "../utils/direct-run.js";
import { type GrepParams, parseBashGrep, handleGrepDirect } from "./grep-direct.js";
import {
  findVirtualPaths,
  listVirtualPathRows,
  readVirtualPathContent,
} from "./virtual-table-query.js";

const log = (msg: string) => _log("pre", msg);

const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
const TILDE_PATH = "~/.deeplake/memory";
const HOME_VAR_PATH = "$HOME/.deeplake/memory";

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const SHELL_BUNDLE = existsSync(join(__bundleDir, "shell", "deeplake-shell.js"))
  ? join(__bundleDir, "shell", "deeplake-shell.js")
  : join(__bundleDir, "..", "shell", "deeplake-shell.js");

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
  "echo", "printf", "tee", "cat",
  "pwd", "cd", "basename", "dirname", "env", "printenv", "hostname", "whoami",
  "date", "seq", "expr", "sleep", "timeout", "time", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  "for", "while", "do", "done", "if", "then", "else", "fi", "case", "esac",
]);

export interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface ClaudePreToolDecision {
  command: string;
  description: string;
}

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

export function getShellCommand(toolName: string, toolInput: Record<string, unknown>): string | null {
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
      if (fp && touchesMemory(fp)) return `cat ${rewritePaths(fp) || "/"}`;
      break;
    }
    case "Bash": {
      const cmd = toolInput.command as string | undefined;
      if (!cmd || !touchesMemory(cmd)) break;
      const rewritten = rewritePaths(cmd);
      if (!isSafe(rewritten)) {
        log(`unsafe command blocked: ${rewritten}`);
        return null;
      }
      return rewritten;
    }
    case "Glob": {
      const p = toolInput.path as string | undefined;
      if (p && touchesMemory(p)) return "ls /";
      break;
    }
  }
  return null;
}

export function buildAllowDecision(command: string, description: string): ClaudePreToolDecision {
  return { command, description };
}

export function extractGrepParams(
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

function buildFallbackDecision(shellCmd: string, shellBundle = SHELL_BUNDLE): ClaudePreToolDecision {
  return buildAllowDecision(
    `node "${shellBundle}" -c "${shellCmd.replace(/"/g, '\\"')}"`,
    `[DeepLake shell] ${shellCmd}`,
  );
}

interface ClaudePreToolDeps {
  config?: ReturnType<typeof loadConfig>;
  createApi?: (table: string, config: NonNullable<ReturnType<typeof loadConfig>>) => DeeplakeApi;
  handleGrepDirectFn?: typeof handleGrepDirect;
  readVirtualPathContentFn?: typeof readVirtualPathContent;
  listVirtualPathRowsFn?: typeof listVirtualPathRows;
  findVirtualPathsFn?: typeof findVirtualPaths;
  shellBundle?: string;
  logFn?: (msg: string) => void;
}

export async function processPreToolUse(input: PreToolUseInput, deps: ClaudePreToolDeps = {}): Promise<ClaudePreToolDecision | null> {
  const {
    config = loadConfig(),
    createApi = (table, activeConfig) => new DeeplakeApi(
      activeConfig.token,
      activeConfig.apiUrl,
      activeConfig.orgId,
      activeConfig.workspaceId,
      table,
    ),
    handleGrepDirectFn = handleGrepDirect,
    readVirtualPathContentFn = readVirtualPathContent,
    listVirtualPathRowsFn = listVirtualPathRows,
    findVirtualPathsFn = findVirtualPaths,
    shellBundle = SHELL_BUNDLE,
    logFn = log,
  } = deps;

  const cmd = (input.tool_input.command as string) ?? "";
  const shellCmd = getShellCommand(input.tool_name, input.tool_input);
  const toolPath = (input.tool_input.file_path ?? input.tool_input.path ?? "") as string;

  if (!shellCmd && (touchesMemory(cmd) || touchesMemory(toolPath))) {
    const guidance = "[RETRY REQUIRED] The command you tried is not available for ~/.deeplake/memory/. " +
      "This virtual filesystem only supports bash builtins: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find, etc. " +
      "python, python3, node, and curl are NOT available. " +
      "You MUST rewrite your command using only the bash tools listed above and try again. " +
      "For example, to parse JSON use: cat file.json | jq '.key'. To count keys: cat file.json | jq 'keys | length'.";
    logFn(`unsupported command, returning guidance: ${cmd}`);
    return buildAllowDecision(
      `echo ${JSON.stringify(guidance)}`,
      "[DeepLake] unsupported command — rewrite using bash builtins",
    );
  }

  if (!shellCmd) return null;
  if (!config) return buildFallbackDecision(shellCmd, shellBundle);

  const table = process.env["HIVEMIND_TABLE"] ?? "memory";
  const sessionsTable = process.env["HIVEMIND_SESSIONS_TABLE"] ?? "sessions";
  const api = createApi(table, config);

  try {
    const grepParams = extractGrepParams(input.tool_name, input.tool_input, shellCmd);
    if (grepParams) {
      logFn(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
      const result = await handleGrepDirectFn(api, table, sessionsTable, grepParams);
      if (result !== null) return buildAllowDecision(`echo ${JSON.stringify(result)}`, `[DeepLake direct] grep ${grepParams.pattern}`);
    }

    let virtualPath: string | null = null;
    let lineLimit = 0;
    let fromEnd = false;

    if (input.tool_name === "Read") {
      virtualPath = rewritePaths((input.tool_input.file_path as string) ?? "");
    } else if (input.tool_name === "Bash") {
      const catCmd = shellCmd.replace(/\s+2>\S+/g, "").trim();
      const catPipeHead = catCmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
      if (catPipeHead) { virtualPath = catPipeHead[1]; lineLimit = Math.abs(parseInt(catPipeHead[2], 10)); }
      if (!virtualPath) {
        const catMatch = catCmd.match(/^cat\s+(\S+)\s*$/);
        if (catMatch) virtualPath = catMatch[1];
      }
      if (!virtualPath) {
        const headMatch = shellCmd.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ??
                          shellCmd.match(/^head\s+(\S+)\s*$/);
        if (headMatch) {
          if (headMatch[2]) { virtualPath = headMatch[2]; lineLimit = Math.abs(parseInt(headMatch[1], 10)); }
          else { virtualPath = headMatch[1]; lineLimit = 10; }
        }
      }
      if (!virtualPath) {
        const tailMatch = shellCmd.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/) ??
                          shellCmd.match(/^tail\s+(\S+)\s*$/);
        if (tailMatch) {
          fromEnd = true;
          if (tailMatch[2]) { virtualPath = tailMatch[2]; lineLimit = Math.abs(parseInt(tailMatch[1], 10)); }
          else { virtualPath = tailMatch[1]; lineLimit = 10; }
        }
      }
      if (!virtualPath) {
        const wcMatch = shellCmd.match(/^wc\s+-l\s+(\S+)\s*$/);
        if (wcMatch) { virtualPath = wcMatch[1]; lineLimit = -1; }
      }
    }

    if (virtualPath && !virtualPath.endsWith("/")) {
      logFn(`direct read: ${virtualPath}`);
      let content = await readVirtualPathContentFn(api, table, sessionsTable, virtualPath);
      if (content === null && virtualPath === "/index.md") {
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
        if (lineLimit === -1) return buildAllowDecision(`echo ${JSON.stringify(`${content.split("\n").length} ${virtualPath}`)}`, `[DeepLake direct] wc -l ${virtualPath}`);
        if (lineLimit > 0) {
          const lines = content.split("\n");
          content = fromEnd ? lines.slice(-lineLimit).join("\n") : lines.slice(0, lineLimit).join("\n");
        }
        const label = lineLimit > 0 ? (fromEnd ? `tail -${lineLimit}` : `head -${lineLimit}`) : "cat";
        return buildAllowDecision(`echo ${JSON.stringify(content)}`, `[DeepLake direct] ${label} ${virtualPath}`);
      }
    }

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
      logFn(`direct ls: ${dir}`);
      const rows = await listVirtualPathRowsFn(api, table, sessionsTable, dir);
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
      return buildAllowDecision(`echo ${JSON.stringify(lines.join("\n") || "(empty directory)")}`, `[DeepLake direct] ls ${dir}`);
    }

    if (input.tool_name === "Bash") {
      const findMatch = shellCmd.match(/^find\s+(\S+)\s+(?:-type\s+\S+\s+)?-name\s+'([^']+)'/);
      if (findMatch) {
        const dir = findMatch[1].replace(/\/+$/, "") || "/";
        const namePattern = sqlLike(findMatch[2]).replace(/\*/g, "%").replace(/\?/g, "_");
        logFn(`direct find: ${dir} -name '${findMatch[2]}'`);
        const paths = await findVirtualPathsFn(api, table, sessionsTable, dir, namePattern);
        let result = paths.join("\n") || "";
        if (/\|\s*wc\s+-l\s*$/.test(shellCmd)) result = String(paths.length);
        return buildAllowDecision(`echo ${JSON.stringify(result || "(no matches)")}`, `[DeepLake direct] find ${dir}`);
      }
    }
  } catch (e: any) {
    logFn(`direct query failed, falling back to shell: ${e.message}`);
  }

  return buildFallbackDecision(shellCmd, shellBundle);
}

async function main(): Promise<void> {
  const input = await readStdin<PreToolUseInput>();
  const decision = await processPreToolUse(input);
  if (!decision) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: decision,
    },
  }));
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
