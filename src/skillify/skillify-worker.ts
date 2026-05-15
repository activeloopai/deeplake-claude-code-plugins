#!/usr/bin/env node

/**
 * Background skillify worker.
 *
 * Pulls the last N sessions from Deeplake in the configured scope, strips
 * tool calls / thinking, asks Haiku whether the recent activity warrants a
 * new or merged skill, and writes the result under the project's
 * .claude/skills directory.
 *
 * Invoked by the capture hook as: node skillify-worker.js <config.json>
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { utcTimestamp } from "../utils/debug.js";
import { deeplakeClientHeader } from "../utils/client-header.js";
import { extractPairs, SessionRow, Pair } from "./extractors/index.js";
import {
  resolveSkillsRoot,
  writeNewSkill,
  mergeSkill,
} from "./skill-writer.js";
import { renderExistingSkillsBlock } from "./existing-skills.js";
import { insertSkillRow } from "./skills-table.js";
import { parseVerdict, type Verdict } from "./gate-parser.js";
import { runGate, type Agent } from "./gate-runner.js";
import { isCrossAuthorMergeVerdict, resolveRecordScope } from "./scope-promotion.js";
import {
  resetCounter,
  recordSkill,
  advanceWatermark,
  readState,
  releaseWorkerLock,
} from "./state.js";

interface WorkerConfig {
  apiUrl: string;
  token: string;
  orgId: string;
  workspaceId: string;
  sessionsTable: string;
  userName: string;
  cwd: string;
  projectKey: string;
  project: string;
  agent: string;
  /**
   * CLI dispatch label for the gate call. Optional. When unset, the gate falls
   * back to `agent`. Used by host environments whose `agent` provenance label
   * isn't itself a CLI we can shell out to (currently: openclaw — a gateway
   * with no `openclaw -p <prompt>` CLI of its own). Letting `agent` stay
   * "openclaw" keeps the source_agent provenance honest in the skills table
   * while `gateAgent` points the gate-runner at a real CLI on the machine.
   */
  gateAgent?: Agent;
  scope: "me" | "team";
  team: string[];
  install: "project" | "global";
  skillsTable: string;
  tmpDir: string;
  /** CLI binary used to run the gate prompt — agent-specific (claude / codex / cursor-agent / hermes). */
  gateBin: string;
  /** Optional model/provider overrides for cursor / hermes. */
  cursorModel?: string;
  hermesProvider?: string;
  hermesModel?: string;
  piProvider?: string;
  piModel?: string;
  skillifyLog: string;
  currentSessionId?: string;
}

const cfg: WorkerConfig = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const tmpDir = cfg.tmpDir;
const verdictPath = join(tmpDir, "verdict.json");
const promptPath = join(tmpDir, "prompt.txt");

const SESSIONS_TO_MINE = 10;
const PAIR_CHAR_CAP = 2_000;
const TOTAL_PAIRS_CHAR_CAP = 40_000;
const EXISTING_SKILLS_CHAR_CAP = 30_000;

function wlog(msg: string): void {
  try {
    appendFileSync(cfg.skillifyLog, `[${utcTimestamp()}] skillify-worker(${cfg.projectKey}): ${msg}\n`);
  } catch { /* ignore */ }
}

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// Hard cap on a single fetch call. A stalled connection (DNS hang,
// half-open socket, transparent proxy that doesn't close) would otherwise
// keep the worker process alive past the wall-clock at which the parent
// already considers the run abandoned. 30s matches the per-attempt budget
// in src/deeplake-api.ts (QUERY_TIMEOUT_MS).
const QUERY_TIMEOUT_MS = 30_000;

async function query(sql: string, retries = 4): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r: Response;
    try {
      r = await fetch(`${cfg.apiUrl}/workspaces/${cfg.workspaceId}/tables/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
          "X-Activeloop-Org-Id": cfg.orgId,
          ...deeplakeClientHeader(),
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        body: JSON.stringify({ query: sql }),
      });
    } catch (e: any) {
      // Network-level failure: AbortSignal timeout, DNS lookup error,
      // ECONNRESET, etc. The original loop only checked HTTP statuses,
      // so a fetch rejection would propagate past the retry path and
      // out of main(); the per-project worker lock would still be
      // released by main()'s finally, but we'd lose the retry budget
      // for transient network blips that the HTTP-status path already
      // handles. Match the exponential-backoff schedule used below for
      // 5xx responses.
      if (attempt < retries) {
        const base = Math.min(30_000, 2000 * Math.pow(2, attempt));
        const delay = base + Math.floor(Math.random() * 1000);
        wlog(`fetch failed (${e?.name ?? e?.code ?? e?.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw e;
    }
    if (r.ok) {
      const j = await r.json() as { columns?: string[]; rows?: unknown[][] };
      if (!j.columns || !j.rows) return [];
      return j.rows.map(row =>
        Object.fromEntries(j.columns!.map((col, i) => [col, row[i]]))
      );
    }
    const retryable = r.status === 401 || r.status === 403 ||
      r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503;
    if (attempt < retries && retryable) {
      const base = Math.min(30_000, 2000 * Math.pow(2, attempt));
      const delay = base + Math.floor(Math.random() * 1000);
      wlog(`API ${r.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}

function authorClause(): string {
  // scope=team with a populated team list mines sessions authored by
  // anyone in that list. scope=me (and scope=team with an empty list)
  // narrows to the current user — there's no whole-workspace mode any
  // more (the previous `scope === "org"` branch returned an unfiltered
  // clause; that surface was dropped when we narrowed Scope to me|team).
  if (cfg.scope === "team" && cfg.team.length > 0) {
    const list = cfg.team.map(n => `'${esc(n)}'`).join(", ");
    return ` AND author IN (${list})`;
  }
  return ` AND author = '${esc(cfg.userName)}'`;
}

async function listCandidateSessions(lastDate: string | null): Promise<{ path: string; lastMsg: string }[]> {
  const dateClause = lastDate ? ` AND creation_date > '${esc(lastDate)}'` : "";
  const sql =
    `SELECT path, MAX(creation_date) AS last_msg ` +
    `FROM "${cfg.sessionsTable}" ` +
    `WHERE project = '${esc(cfg.project)}'${authorClause()}${dateClause} ` +
    `GROUP BY path ` +
    `ORDER BY last_msg DESC ` +
    `LIMIT ${SESSIONS_TO_MINE * 2}`; // overshoot — we'll filter the in-flight session below
  const rows = await query(sql);
  return rows
    .map(r => ({ path: String(r.path ?? ""), lastMsg: String(r.last_msg ?? "") }))
    .filter(r => r.path.length > 0);
}

function isCurrentSession(path: string): boolean {
  return cfg.currentSessionId ? path.includes(cfg.currentSessionId) : false;
}

async function fetchSessionRows(path: string): Promise<SessionRow[]> {
  const rows = await query(
    `SELECT message, creation_date, agent ` +
    `FROM "${cfg.sessionsTable}" ` +
    `WHERE path = '${esc(path)}' ` +
    `ORDER BY creation_date ASC`
  );
  // sessionId = filename without extension; pull from path tail
  const sessionId = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  return rows.map(r => {
    const m = r.message as Record<string, unknown> | string | null;
    const parsed = typeof m === "string" ? safeJsonParse(m) : (m ?? {});
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
      creation_date: r.creation_date as string | undefined,
      session_id: sessionId,
      agent: r.agent as string | undefined,
    };
  });
}

function safeJsonParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[…truncated ${s.length - max} chars]`;
}

function renderPairsBlock(pairs: Pair[]): string {
  let total = 0;
  const out: string[] = [];
  for (const [i, p] of pairs.entries()) {
    const prompt = truncate(p.prompt, PAIR_CHAR_CAP);
    const answer = truncate(p.answer, PAIR_CHAR_CAP);
    const block =
      `--- exchange ${i + 1} (session ${p.sessionId.slice(0, 8)}, agent ${p.agent ?? "?"}) ---\n` +
      `USER:\n${prompt}\n\nASSISTANT:\n${answer}\n`;
    if (total + block.length > TOTAL_PAIRS_CHAR_CAP) {
      out.push(`[…${pairs.length - i} more exchanges omitted to stay under prompt budget]`);
      break;
    }
    out.push(block);
    total += block.length;
  }
  return out.join("\n");
}

// renderExistingSkillsBlock is exported from existing-skills.ts so we can
// unit-test the project+global merging and the [global, read-only] tagging
// without instantiating the whole worker (which reads its config from argv).

function buildPrompt(pairs: Pair[]): string {
  const existing = renderExistingSkillsBlock(cfg.cwd, EXISTING_SKILLS_CHAR_CAP);
  const mergeTargetsClause = existing.mergeTargetNames.length > 0
    ? `MERGE is allowed only if your "name" is EXACTLY one of: [${existing.mergeTargetNames.join(", ")}]. Any other name MUST use KEEP, not MERGE.`
    : `MERGE is FORBIDDEN — there are no existing skills to merge into. Use KEEP or SKIP only.`;
  return [
    `You are a skill curator for the "${cfg.project}" project. You decide whether the recent`,
    `agent activity below contains a recurring, non-trivial pattern worth crystallizing as a`,
    `reusable skill, and whether to create a new skill or merge into an existing one.`,
    ``,
    `RULES:`,
    `- KEEP only if the pattern recurs across at least 3 of the exchanges, is non-obvious to a`,
    `  competent engineer, and is not already covered by an existing skill below.`,
    `- SKIP if the activity is one-off, generic engineering work, or already covered.`,
    `- MERGE if the pattern is a meaningful extension of an existing skill — produce a`,
    `  merged body that incorporates the new evidence without exceeding ~3000 characters or`,
    `  covering unrelated domains.`,
    `- ${mergeTargetsClause}`,
    `- Cross-author MERGE has a real cost: editing a skill authored by someone else is`,
    `  recorded as a team-level edit (scope=team, contributors+="${cfg.userName}"). Use it only`,
    `  when the new evidence genuinely extends the existing skill; otherwise pick KEEP or SKIP.`,
    `  Tags like [project, author=alice] / [global, author=bob] tell you whose skill it is.`,
    `- Skill bodies should follow the existing style: short sections (When to use, Workflow,`,
    `  Anti-patterns), concrete commands and file paths drawn from the exchanges, no marketing.`,
    ``,
    `=== EXISTING SKILLS (all MERGE-eligible; [global, author=X] entries from teammate X mean`,
    `cross-author MERGE auto-promotes scope to team) ===`,
    existing.block,
    ``,
    `=== RECENT EXCHANGES (prompt + answer pairs, tool calls already stripped) ===`,
    renderPairsBlock(pairs),
    ``,
    `=== YOUR TASK ===`,
    `Output your decision as a single JSON object. The worker will parse it.`,
    `You may either:`,
    `  (a) Write the JSON to this exact path using the Write tool: ${verdictPath}`,
    `  (b) Print the JSON object to stdout (your final message), nothing else.`,
    `Either path works; pick whichever you prefer. Do not do both.`,
    ``,
    `The JSON MUST have this shape:`,
    `{`,
    `  "verdict": "KEEP" | "SKIP" | "MERGE",`,
    `  "name": "<kebab-case skill name; for MERGE, the existing skill name>",`,
    `  "description": "<one-line>",`,
    `  "trigger": "<short trigger description, optional>",`,
    `  "body": "<full SKILL.md body WITHOUT frontmatter; KEEP and MERGE only>",`,
    `  "reason": "<one-line justification>"`,
    `}`,
    ``,
    `For SKIP, only "verdict" and "reason" are required.`,
    `If you print to stdout, do not include any prose before or after the JSON.`,
    `Do not write any other files.`,
  ].join("\n");
}

/**
 * Read the verdict from disk if Haiku used the Write tool, otherwise fall
 * back to stdout (some runs print the JSON instead of writing the file).
 * Returns the verdict + a debug source for logging.
 */
function readVerdict(stdout: string): { verdict: Verdict | null; source: string } {
  if (existsSync(verdictPath)) {
    try {
      const text = readFileSync(verdictPath, "utf-8");
      const v = parseVerdict(text);
      if (v) return { verdict: v, source: "file" };
      return { verdict: null, source: `file-unparseable (${text.length} chars)` };
    } catch (e: any) {
      return { verdict: null, source: `file-read-error: ${e.message}` };
    }
  }
  const v = parseVerdict(stdout);
  if (v) return { verdict: v, source: "stdout" };
  return { verdict: null, source: `no-file-no-stdout-json (stdout=${stdout.length} chars)` };
}

function cleanup(keep: boolean): void {
  if (keep) {
    wlog(`keeping tmpDir for inspection: ${tmpDir}`);
    return;
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); }
  catch (e: any) { wlog(`cleanup failed: ${e.message}`); }
}

let keepTmpForInspection = false;

async function main(): Promise<void> {
  try {
    const state = readState(cfg.projectKey);
    const lastDate = state?.lastDate ?? null;

    wlog(`fetching candidate sessions (scope=${cfg.scope}, lastDate=${lastDate ?? "none"})`);
    const candidates = await listCandidateSessions(lastDate);
    const usable = candidates.filter(c => !isCurrentSession(c.path)).slice(0, SESSIONS_TO_MINE);
    if (usable.length === 0) {
      wlog("no new sessions to mine — done");
      return;
    }

    wlog(`mining ${usable.length} sessions`);
    const allPairs: Pair[] = [];
    for (const c of usable) {
      const rows = await fetchSessionRows(c.path);
      const pairs = extractPairs(rows);
      allPairs.push(...pairs);
    }

    if (allPairs.length === 0) {
      wlog("no prompt/answer pairs after extraction — advancing watermark and exiting");
      // Watermark = OLDEST mined session, not newest. SQL ORDERS sessions
      // DESC, then we LIMIT N. If we set the watermark to the newest, any
      // session older than the LIMIT cutoff is permanently skipped on the
      // next run. Setting it to the oldest mined session means the next run
      // will re-see the same N (probably yielding SKIP) but ALSO see anything
      // older that we missed in this batch. Re-mining is benign — same input
      // → SKIP, no new DB row.
      const oldest = usable[usable.length - 1];
      advanceWatermark(cfg.projectKey, oldest.path, oldest.lastMsg);
      return;
    }

    wlog(`extracted ${allPairs.length} pairs across ${usable.length} sessions`);

    const prompt = buildPrompt(allPairs);
    writeFileSync(promptPath, prompt);

    const gateAgent = (cfg.gateAgent ?? cfg.agent) as Agent;
    wlog(`running gate (agent=${cfg.agent}, gateAgent=${gateAgent}, bin=${cfg.gateBin}, prompt=${prompt.length} chars)`);
    const gate = runGate({
      agent: gateAgent,
      prompt,
      bin: cfg.gateBin,
      cursorModel: cfg.cursorModel,
      hermesProvider: cfg.hermesProvider,
      hermesModel: cfg.hermesModel,
      piProvider: cfg.piProvider,
      piModel: cfg.piModel,
      timeoutMs: 120_000,
    });
    // Always persist stdout/stderr for debugging
    try {
      writeFileSync(join(tmpDir, "gate-stdout.txt"), gate.stdout);
      if (gate.stderr) writeFileSync(join(tmpDir, "gate-stderr.txt"), gate.stderr);
    } catch { /* ignore */ }

    if (gate.errored) {
      wlog(`gate failed: ${gate.errorMessage} (stdout=${gate.stdout.length}, stderr=${gate.stderr.length})`);
      return;
    }
    wlog(`gate exited (code 0, stdout=${gate.stdout.length} chars)`);

    const { verdict, source } = readVerdict(gate.stdout);
    if (!verdict) {
      wlog(`no parseable verdict (${source}) — treating as SKIP, advancing watermark`);
      keepTmpForInspection = true;
      const oldest = usable[usable.length - 1];
      advanceWatermark(cfg.projectKey, oldest.path, oldest.lastMsg);
      return;
    }
    wlog(`verdict source: ${source}`);

    wlog(`verdict=${verdict.verdict} name=${verdict.name ?? "-"} reason=${verdict.reason ?? "-"}`);

    // Watermark is the OLDEST mined session date — same reasoning as the
    // no-pairs branch above: setting it to the newest would permanently
    // skip any session older than the LIMIT cutoff that we couldn't fit
    // into this batch. Re-mining the recent N on the next run is benign
    // (gate yields SKIP).
    const oldest = usable[usable.length - 1];
    const watermarkUuid = (oldest.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    const watermarkDate = oldest.lastMsg;
    const sourceSessions = usable.map(c =>
      (c.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "")
    );

    /**
     * After a successful local write/merge, push a row to the Deeplake
     * `skills` table for org-wide provenance. Failures here do not abort
     * the local write — the local file is the source of truth, the table
     * is a side-channel index. We log and move on.
     *
     * Issue #118 — auto-promotion of scope:
     *   - KEEP, or MERGE by the original author -> scope unchanged
     *     (`cfg.scope`, normally "me"), `author = cfg.userName`,
     *     `contributors` reflects the (single) author list from the
     *     local SKILL.md write.
     *   - MERGE where the existing skill's author != cfg.userName -> the
     *     `scope` of the new row is bumped to "team" so future readers
     *     can see the skill is co-owned. `author` keeps the v=1 author
     *     (immutable lineage), `contributors` gets the editor appended
     *     by mergeSkill itself.
     */
    async function recordToDeeplake(
      result: {
        path: string;
        version: number;
        createdAt: string;
        updatedAt: string;
        author?: string;
        contributors: string[];
      },
      verdict: Verdict,
    ): Promise<void> {
      // Author stamped on the DB row is the *original* author when one is
      // known (preserves lineage across merges); falls back to the current
      // user for a fresh KEEP or a legacy local file with no frontmatter author.
      const author = result.author ?? cfg.userName;
      // Auto-promote: cross-author MERGE bumps `scope=me` to `scope=team`.
      // Pure helpers in ./scope-promotion.ts pin the policy (one-directional
      // promotion, no `org -> team` downgrade) so the regression tests can
      // exercise it without standing up the whole worker.
      const isCrossAuthorMerge = isCrossAuthorMergeVerdict({
        verdict: verdict.verdict,
        resultAuthor: result.author,
        userName: cfg.userName,
      });
      const scope = resolveRecordScope({
        configScope: cfg.scope,
        isCrossAuthorMerge,
      });
      // Contributors come from the skill-writer (it merges previous list
      // with the editor). For a legacy KEEP without author, the list is
      // empty; downstream readers fall back to [author] in that case.
      const contributors = result.contributors;
      try {
        await insertSkillRow({
          query,
          tableName: cfg.skillsTable,
          name: verdict.name!,
          project: cfg.project,
          projectKey: cfg.projectKey,
          localPath: result.path,
          install: cfg.install,
          sourceSessions,
          sourceAgent: cfg.agent,
          scope,
          author,
          contributors,
          description: verdict.description ?? "",
          trigger: verdict.trigger,
          body: verdict.body!,
          version: result.version,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        });
        wlog(
          `recorded to skills table: name=${verdict.name} v${result.version} ` +
          `author=${author} scope=${scope} contributors=${contributors.length}` +
          (isCrossAuthorMerge ? " [auto-promoted me->team]" : ""),
        );
      } catch (e: any) {
        wlog(`skills table insert failed (non-fatal): ${e.message}`);
      }
    }

    if (verdict.verdict === "KEEP" && verdict.name && verdict.body) {
      try {
        const result = writeNewSkill({
          skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
          name: verdict.name,
          description: verdict.description ?? "",
          trigger: verdict.trigger,
          body: verdict.body,
          sourceSessions,
          agent: cfg.agent,
          author: cfg.userName,
        });
        wlog(`wrote new skill: ${result.path}`);
        recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
        await recordToDeeplake(result, verdict);
      } catch (e: any) {
        wlog(`writeNewSkill failed: ${e.message}`);
        advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
      }
    } else if (verdict.verdict === "MERGE" && verdict.name && verdict.body) {
      try {
        const result = mergeSkill({
          skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
          name: verdict.name,
          description: verdict.description,
          body: verdict.body,
          newSourceSessions: sourceSessions,
          agent: cfg.agent,
          editor: cfg.userName,
        });
        wlog(`merged into skill: ${result.path} (v${result.version})`);
        recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
        await recordToDeeplake(result, verdict);
      } catch (e: any) {
        // The gate sometimes hallucinates a MERGE target that exists in the
        // user's global skills (~/.claude/skills/) but not in this project.
        // Fall back to writing a new project skill so the body isn't lost.
        if (/does not exist/i.test(e.message ?? "")) {
          wlog(`mergeSkill target missing — falling back to writeNewSkill: ${verdict.name}`);
          try {
            const result = writeNewSkill({
              skillsRoot: resolveSkillsRoot(cfg.install, cfg.cwd),
              name: verdict.name,
              description: verdict.description ?? "",
              trigger: verdict.trigger,
              body: verdict.body,
              sourceSessions,
              agent: cfg.agent,
              author: cfg.userName,
            });
            wlog(`wrote new skill (merge fallback): ${result.path}`);
            recordSkill(cfg.projectKey, verdict.name, watermarkUuid, watermarkDate);
            await recordToDeeplake(result, verdict);
          } catch (e2: any) {
            wlog(`writeNewSkill fallback also failed: ${e2.message}`);
            advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
          }
        } else {
          wlog(`mergeSkill failed: ${e.message}`);
          advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
        }
      }
    } else {
      // SKIP, or KEEP/MERGE with missing fields — just advance watermark.
      advanceWatermark(cfg.projectKey, watermarkUuid, watermarkDate);
    }
  } catch (e: any) {
    wlog(`fatal: ${e.message}`);
  } finally {
    // Counter was already reset by the hook before spawn, so we don't touch it here.
    cleanup(keepTmpForInspection);
    try { releaseWorkerLock(cfg.projectKey); }
    catch (e: any) { wlog(`releaseWorkerLock failed: ${e.message}`); }
  }
}

main();
