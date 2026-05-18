/**
 * Discover and pre-process local agent session transcripts WITHOUT touching
 * Deeplake. Powers `hivemind skillify mine-local`, which seeds skills for
 * fresh installs that haven't logged in yet.
 *
 * Two concerns live here:
 *  1. Agent + session detection: which agents have a session dir on disk,
 *     and which JSONLs sit under each.
 *  2. Selection policy: ε-greedy pick of N sessions, biased toward the
 *     current cwd-encoded dir, with global-recent top-up.
 *
 * Conversion from native Claude Code JSONL → the SessionRow shape consumed
 * by extractPairs() also lives here so the worker doesn't need to know
 * about local-file schemas.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRow } from "./extractors/index.js";

export type LocalAgent = "claude_code" | "codex" | "cursor" | "hermes";

export interface AgentInstall {
  agent: LocalAgent;
  sessionRoot: string;
  encodeCwd: (cwd: string) => string;
}

const HOME = homedir();

/**
 * Claude Code encodes cwd into the projects/ dir name by replacing both `/`
 * and `_` with `-`. Verified against ~/.claude/projects/ entries — the dir
 * for cwd `/home/emanuele/39_claude_code_plugin/deeplake-claude-code-plugins`
 * lands as `-home-emanuele-39-claude-code-plugin-deeplake-claude-code-plugins`,
 * NOT `-home-emanuele-39_claude_code_plugin-deeplake-claude-code-plugins`.
 */
function encodeCwdClaudeCode(cwd: string): string {
  return cwd.replace(/[/_]/g, "-");
}

/** Detect installed agents by checking for their session root dirs. */
export function detectInstalledAgents(): AgentInstall[] {
  const installs: AgentInstall[] = [];

  const claudeRoot = join(HOME, ".claude", "projects");
  if (existsSync(claudeRoot)) {
    installs.push({
      agent: "claude_code",
      sessionRoot: claudeRoot,
      encodeCwd: encodeCwdClaudeCode,
    });
  }

  // Codex/Cursor/Hermes — detection is best-effort. Each agent's encoded-cwd
  // scheme differs, and as of v1 we only have a verified mapping for Claude
  // Code. For other agents we still surface their session files (so the
  // user knows we found them) but mark every file as in_cwd=false, which
  // means they only get picked via the ε-greedy global quota.
  const codexRoot = join(HOME, ".codex", "sessions");
  if (existsSync(codexRoot)) {
    installs.push({
      agent: "codex",
      sessionRoot: codexRoot,
      encodeCwd: () => "__cwd_unknown__",
    });
  }

  return installs;
}

/**
 * Detect whether we're running inside an agent (vs. a plain shell). When
 * detected, the CLI can skip interactive prompts and default to the host's
 * configuration. We look at agent-set env vars rather than parent-pid
 * inspection because the former is what each agent already commits to.
 */
export function detectHostAgent(): LocalAgent | null {
  if (process.env.CLAUDECODE === "1" || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude_code";
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION_ID) return "codex";
  return null;
}

export interface SessionFile {
  agent: LocalAgent;
  path: string;
  mtime: number;
  inCwd: boolean;
  sessionId: string;
}

/** List all session JSONL files across installed agents, with cwd tagging. */
export function listLocalSessions(installs: AgentInstall[], cwd: string): SessionFile[] {
  const out: SessionFile[] = [];
  for (const install of installs) {
    const cwdEncoded = install.encodeCwd(cwd);
    let subdirs: string[] = [];
    try { subdirs = readdirSync(install.sessionRoot); } catch { continue; }
    for (const sub of subdirs) {
      const subdirPath = join(install.sessionRoot, sub);
      try {
        if (!statSync(subdirPath).isDirectory()) continue;
      } catch { continue; }
      const inCwd = sub === cwdEncoded;
      let files: string[] = [];
      try { files = readdirSync(subdirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fullPath = join(subdirPath, f);
        let stats;
        try { stats = statSync(fullPath); } catch { continue; }
        if (!stats.isFile()) continue;
        const sessionId = f.replace(/\.jsonl$/, "");
        out.push({
          agent: install.agent,
          path: fullPath,
          mtime: stats.mtimeMs,
          inCwd,
          sessionId,
        });
      }
    }
  }
  return out;
}

/**
 * Three-phase ε-greedy pick:
 *   Phase 1 — cwd quota:   ⌈(1-ε)·N⌉ newest cwd sessions
 *   Phase 2 — global quota: ⌊ε·N⌋    newest non-already-picked sessions
 *   Phase 3 — top-up:       fill the remainder from any non-picked
 *
 * Dedup key is absolute path; the same file can never appear twice. Handles
 * the degenerate cases cleanly:
 *   - all in cwd: phase 1 fills, phase 2 finds nothing, phase 3 tops up from cwd
 *   - none in cwd: phase 1 empty, phase 2 + 3 fill from global
 */
export function pickSessions(
  candidates: SessionFile[],
  opts: { n: number; epsilon: number },
): SessionFile[] {
  const { n, epsilon } = opts;
  if (n <= 0 || candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => b.mtime - a.mtime);
  const cwdQuota = Math.ceil((1 - epsilon) * n);
  const globalQuota = Math.floor(epsilon * n);

  const picked: SessionFile[] = [];
  const taken = new Set<string>();

  for (const s of sorted) {
    if (picked.length >= cwdQuota) break;
    if (s.inCwd && !taken.has(s.path)) {
      picked.push(s);
      taken.add(s.path);
    }
  }

  const cap2 = picked.length + globalQuota;
  for (const s of sorted) {
    if (picked.length >= cap2) break;
    if (!taken.has(s.path)) {
      picked.push(s);
      taken.add(s.path);
    }
  }

  for (const s of sorted) {
    if (picked.length >= n) break;
    if (!taken.has(s.path)) {
      picked.push(s);
      taken.add(s.path);
    }
  }

  return picked;
}

/**
 * Convert a native Claude Code JSONL file into the SessionRow shape that
 * extractPairs() expects.
 *
 * Native schema (per line):
 *   { type: "user",      message: { content: <string|array> }, timestamp }
 *   { type: "assistant", message: { content: <array of blocks> }, timestamp }
 *   { type: "system"|"attachment"|"last-prompt"|... }              ← dropped
 *
 * Semantics mirror what the production capture hook stores in Deeplake:
 *   - User: only string-content user messages (the typed prompt). Tool-result
 *     arrays sent back to the model are dropped.
 *   - Assistant: only the LAST text-bearing assistant entry per turn — the
 *     same `last_assistant_message` the Stop hook captures. Without this we
 *     would emit every intermediate "Now I'll run X" mini-narration that
 *     surrounds tool calls, producing a soliloquy the gate can't reason
 *     about because the tools (and their results) are stripped.
 */
export function nativeJsonlToRows(filePath: string, sessionId: string, agent: string): SessionRow[] {
  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return []; }

  const rows: SessionRow[] = [];
  // Buffer the most recent assistant text seen since the last user message;
  // flushed on the next user_message or at EOF.
  let pendingAsstText: string | undefined;
  let pendingAsstTs: string | undefined;

  const flushAssistant = (): void => {
    if (pendingAsstText && pendingAsstText.trim().length > 0) {
      rows.push({
        type: "assistant_message",
        content: pendingAsstText,
        creation_date: pendingAsstTs,
        session_id: sessionId,
        agent,
      });
    }
    pendingAsstText = undefined;
    pendingAsstTs = undefined;
  };

  for (const line of raw.split(/\n/)) {
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const t = obj?.type;
    const ts: string | undefined = obj?.timestamp ?? obj?.created_at;

    if (t === "user") {
      const c = obj?.message?.content;
      if (typeof c === "string" && c.trim().length > 0) {
        flushAssistant();
        rows.push({
          type: "user_message",
          content: c,
          creation_date: ts,
          session_id: sessionId,
          agent,
        });
      }
    } else if (t === "assistant") {
      const c = obj?.message?.content;
      if (Array.isArray(c)) {
        const text = c
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n\n");
        if (text.trim().length > 0) {
          pendingAsstText = text;
          pendingAsstTs = ts;
        }
      }
    }
  }
  flushAssistant();

  return rows;
}
