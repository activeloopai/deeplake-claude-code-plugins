/**
 * `hivemind skillify mine-local` — seed reusable skills from a fresh user's
 * own local agent transcripts, no Deeplake auth required.
 *
 * Why this exists: a user who just installed hivemind hasn't logged in yet
 * but already has weeks of local Claude Code sessions on disk. Mining those
 * once at install time produces an immediate "huh, this thing is useful"
 * moment without first asking them to sign up.
 *
 * Pipeline (reuses everything from src/skillify/* except the session source):
 *   1. Detect installed agents by their session-dir presence.
 *   2. ε-greedy pick N sessions: cwd-biased, globally-newest top-up.
 *   3. Convert native JSONL → SessionRow → user/assistant pairs.
 *   4. Run a single LLM gate call on all combined pairs.
 *   5. Write KEEP verdict via writeNewSkill, log to manifest.
 *
 * Manifest at ~/.claude/hivemind/local-mined.json doubles as a one-shot
 * sentinel — re-runs require --force. The manifest also tracks which
 * skills came from local mining so a later `push-local` (when the user
 * signs in) can upload exactly those.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  detectInstalledAgents,
  detectHostAgent,
  listLocalSessions,
  pickSessions,
  nativeJsonlToRows,
  type AgentInstall,
  type LocalAgent,
  type SessionFile,
} from "../skillify/local-source.js";
import { extractPairs, type Pair } from "../skillify/extractors/index.js";
import { findAgentBin, type Agent } from "../skillify/gate-runner.js";
import { extractJsonBlock } from "../skillify/gate-parser.js";
import { resolveSkillsRoot, writeNewSkill, listSkills, parseFrontmatter } from "../skillify/skill-writer.js";
import { detectAgentSkillsRoots } from "../skillify/agent-roots.js";
import { fanOutSymlinks } from "../skillify/pull.js";
import {
  LOCAL_MANIFEST_PATH,
  LOCAL_MINE_LOCK_PATH,
  readLocalManifest,
  writeLocalManifest,
  type LocalManifest,
  type LocalManifestEntry,
} from "../skillify/local-manifest.js";
import { unlinkSync } from "node:fs";

const EPSILON = 0.3;
const DEFAULT_N = 8;
const PAIR_CHAR_CAP = 4_000;
const PER_SESSION_PAIR_CAP = 30;
const PER_SESSION_PROMPT_CAP = 120_000; // soft cap per session prompt
const GATE_CONCURRENCY = 4;
// Sessions modified within this window are assumed in-flight (the agent
// is still writing to them). Mining the live session pollutes the gate
// with meta-discussion about the feature under construction.
const IN_FLIGHT_MAX_AGE_MS = 60_000;
const GATE_TIMEOUT_MS = 240_000;

// MANIFEST_PATH + types + read/write helpers now live in
// src/skillify/local-manifest.ts so the SessionStart hooks can consume
// them without dragging the rest of this orchestrator's transitive deps
// (gate runner, parallelMap, etc.) into the hook bundle. Local aliases
// kept for readability inside this file only.
const MANIFEST_PATH = LOCAL_MANIFEST_PATH;
type ManifestEntry = LocalManifestEntry;
type Manifest = LocalManifest;

/**
 * Run the gate by piping the prompt to the agent CLI's stdin instead of
 * passing it as argv. The shared runGate() in gate-runner.ts uses
 * execFileSync with the prompt in argv, which hits Linux's MAX_ARG_STRLEN
 * (~128 KB per single arg) for the larger prompts mine-local builds.
 * stdin has no such cap, so we can push a multi-hundred-KB prompt without
 * touching the shared worker code path.
 *
 * Only handles claude_code today. Other agents (codex/cursor/hermes/pi)
 * keep the existing argv-bound runGate until we verify their stdin
 * semantics. mine-local in v1 only auto-selects claude_code as the gate
 * when running inside Claude Code anyway.
 */
function runGateViaStdin(opts: {
  agent: Agent;
  bin: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; errored: boolean; errorMessage?: string }> {
  return new Promise((resolve) => {
    if (opts.agent !== "claude_code") {
      resolve({
        stdout: "",
        stderr: "",
        errored: true,
        errorMessage: `stdin gate runner only supports claude_code (got ${opts.agent}); for other agents the prompt must fit in argv`,
      });
      return;
    }
    if (!existsSync(opts.bin)) {
      resolve({
        stdout: "",
        stderr: "",
        errored: true,
        errorMessage: `agent binary not found at ${opts.bin}`,
      });
      return;
    }

    const args = [
      "-p",
      "--no-session-persistence",
      "--model", "haiku",
      "--permission-mode", "bypassPermissions",
    ];
    const child = spawn(opts.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { stdout: string; stderr: string; errored: boolean; errorMessage?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({
        stdout, stderr, errored: true,
        errorMessage: `gate timed out after ${opts.timeoutMs}ms`,
      });
    }, opts.timeoutMs);

    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr, errored: true, errorMessage: e.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({
        stdout, stderr,
        errored: code !== 0,
        errorMessage: code !== 0 ? `claude_code CLI exited with code ${code}` : undefined,
      });
    });

    child.stdin.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr, errored: true, errorMessage: `stdin write failed: ${e.message}` });
    });
    child.stdin.end(opts.prompt);
  });
}

// Read/write delegate to the shared module so future callers (SessionStart
// hooks, push-local) hit the same code path.
const loadManifest = readLocalManifest;
const saveManifest = writeLocalManifest;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[…truncated ${s.length - max} chars]`;
}

function renderPairsBlock(pairs: Pair[]): string {
  let total = 0;
  const out: string[] = [];
  for (const [i, p] of pairs.entries()) {
    const block =
      `--- exchange ${i + 1} ---\n` +
      `USER:\n${truncate(p.prompt, PAIR_CHAR_CAP)}\n\nASSISTANT:\n${truncate(p.answer, PAIR_CHAR_CAP)}\n`;
    if (total + block.length > PER_SESSION_PROMPT_CAP) {
      out.push(`[…${pairs.length - i} more exchanges omitted to stay under budget]`);
      break;
    }
    out.push(block);
    total += block.length;
  }
  return out.join("\n");
}

/**
 * Per-session gate prompt. One call sees ONE session's exchanges and is
 * asked for up to 3 distinct skills from that session alone. Aggregation
 * across sessions (dedup, latest-wins) happens after all parallel calls
 * return — concatenating sessions in a single prompt makes no sense when
 * different sessions cover unrelated projects.
 */
function buildSessionPrompt(pairs: Pair[], session: SessionFile, verdictPath: string): string {
  return [
    `You are a skill curator examining ONE session of recent agent activity.`,
    `Your job: identify up to 3 distinct, non-overlapping reusable skills hiding in this session.`,
    `Distinct = different problem domains. Empty list is fine if nothing qualifies.`,
    ``,
    `Session: ${session.sessionId} (agent: ${session.agent})`,
    ``,
    `RULES:`,
    `- A skill qualifies if it captures a concrete, repeatable workflow OR a non-obvious`,
    `  constraint/gotcha a future engineer would benefit from knowing. Intra-session is fine —`,
    `  one deep dive yielding a generalizable takeaway counts.`,
    `- Skip patterns that are obvious from reading the codebase or already in CLAUDE.md.`,
    `- Each body uses short sections (When to use, Workflow, Anti-patterns), concrete commands`,
    `  / paths / snippets drawn from the exchanges below, no marketing, no emojis.`,
    `- Each body under ~3000 characters.`,
    `- Skill names are kebab-case slugs (lowercase letters/digits/hyphens only).`,
    ``,
    `=== EXCHANGES (user prompts + assistant final answers, tool calls stripped) ===`,
    renderPairsBlock(pairs),
    ``,
    `=== YOUR TASK ===`,
    `Output a single JSON object. You may either:`,
    `  (a) Write the JSON to this exact path using the Write tool: ${verdictPath}`,
    `  (b) Print the JSON object to stdout as your final message, nothing else.`,
    `Pick whichever you prefer. Do not do both.`,
    ``,
    `Required shape:`,
    `{`,
    `  "reason": "<one-line justification>",`,
    `  "skills": [`,
    `    {`,
    `      "name": "<kebab-case>",`,
    `      "description": "<one-line>",`,
    `      "trigger": "<short trigger>",`,
    `      "body": "<full SKILL.md body without frontmatter>"`,
    `    },`,
    `    ... up to 3 entries, or [] if nothing qualifies`,
    `  ]`,
    `}`,
    ``,
    `If you print to stdout, do not include any prose before or after the JSON.`,
  ].join("\n");
}

export interface MinedSkill {
  name: string;
  description: string;
  trigger?: string;
  body: string;
}

export interface MultiVerdict {
  reason?: string;
  skills: MinedSkill[];
}

/**
 * Parse the multi-skill gate output. Accepts the same flexible envelopes
 * extractJsonBlock supports (fenced ```json, raw JSON, JSON-wrapped-in-prose),
 * then validates the {reason, skills[]} shape and per-skill required fields.
 * Returns null on any failure; a successful return guarantees skills is an
 * array (possibly empty = SKIP).
 */
export function parseMultiVerdict(raw: string): MultiVerdict | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let parsed: any;
  try { parsed = JSON.parse(block); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const skills = parsed.skills;
  if (!Array.isArray(skills)) return null;
  const out: MinedSkill[] = [];
  for (const s of skills) {
    if (!s || typeof s !== "object") continue;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    const description = typeof s.description === "string" ? s.description.trim() : "";
    const body = typeof s.body === "string" ? s.body.trim() : "";
    const trigger = typeof s.trigger === "string" ? s.trigger.trim() : undefined;
    if (!name || !body) continue;
    out.push({ name, description, body, trigger });
  }
  return { reason: typeof parsed.reason === "string" ? parsed.reason : undefined, skills: out };
}

/**
 * Pick the LLM gate to invoke for mining. v1 only ships a working
 * stdin-prompt path for claude_code (see runGateViaStdin — argv-bound for
 * other agents would hit MAX_ARG_STRLEN on the prompts we build). So if
 * Claude Code is installed locally we always pick it, even when the host
 * agent is something else (e.g. running mine-local inside a Codex session
 * on a machine that also has Claude Code). Only fall back to the host /
 * first-install when claude_code isn't available, and the caller is
 * expected to fail fast in that case rather than burn through every
 * session with `runGateViaStdin` rejecting each one.
 */
function gateAgentFor(
  host: LocalAgent | null,
  fallback: LocalAgent,
  installs: AgentInstall[],
): Agent {
  const installed = new Set(installs.map(i => i.agent));
  if (installed.has("claude_code")) return "claude_code" as Agent;
  return (host ?? fallback) as Agent;
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight at any time.
 * Preserves input order in the returned array. Each task settles its own
 * promise so a single failure doesn't reject the whole batch — callers
 * inspect per-item results.
 */
async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

interface SessionGateResult {
  session: SessionFile;
  skills: MinedSkill[];
  reason: string | null;
  error: string | null;
}

// Tokens shorter than this or matching this stoplist are excluded from
// Jaccard so generic English doesn't drive false-positive overlaps.
const SUMMARY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "via", "this", "that", "your",
  "you", "are", "was", "were", "use", "using", "uses", "used", "skill",
  "when", "what", "where", "which", "while", "how", "non", "any", "all",
  "code", "file", "files", "way", "ways", "via",
]);

export function summaryTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 3 && !SUMMARY_STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Two skills are considered overlapping if their description-token Jaccard
 *  meets this threshold. Tuned empirically: ~0.4 catches "test agent setup"
 *  vs "agent test e2e setup" but lets "deeplake table diagnostics" coexist
 *  with "deeplake API error handling".
 */
const OVERLAP_THRESHOLD = 0.4;

export function findOverlap(
  candidateDesc: string,
  others: ReadonlyArray<{ name: string; desc: string }>,
): { name: string; score: number } | null {
  const ct = summaryTokens(candidateDesc);
  let best: { name: string; score: number } | null = null;
  for (const e of others) {
    const score = jaccard(ct, summaryTokens(e.desc));
    if (score >= OVERLAP_THRESHOLD && (!best || score > best.score)) {
      best = { name: e.name, score };
    }
  }
  return best;
}

/** Load (name, description) for every locally-installed skill so we can
 *  detect duplicates of skills the user already has — pulled, mined, or
 *  hand-written. */
function loadExistingSummaries(skillsRoot: string): Array<{ name: string; desc: string }> {
  const out: Array<{ name: string; desc: string }> = [];
  for (const s of listSkills(skillsRoot)) {
    const parsed = parseFrontmatter(s.body);
    const desc = (parsed?.fm.description as string | undefined) ?? "";
    if (desc) out.push({ name: s.name, desc });
  }
  return out;
}

function takeFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  args.splice(idx, 2);
  return v;
}

function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

export async function runMineLocal(args: string[]): Promise<void> {
  // Auto-mine launched via spawn-mine-local-worker.ts plants a lock file
  // so concurrent SessionStart fires don't spawn duplicate workers. We
  // need to release the lock on ANY exit path — including the
  // process.exit(1) calls below — so install an `exit` handler in
  // addition to the try/finally. process.exit skips finally blocks
  // inside an async function, but it does fire 'exit' handlers.
  let lockReleased = false;
  const releaseLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    try { unlinkSync(LOCAL_MINE_LOCK_PATH); } catch { /* best-effort */ }
  };
  process.on("exit", releaseLock);
  try {
    return await runMineLocalImpl(args);
  } finally {
    releaseLock();
  }
}

async function runMineLocalImpl(args: string[]): Promise<void> {
  const work = [...args];
  const force = takeBoolFlag(work, "--force");
  const dryRun = takeBoolFlag(work, "--dry-run");
  const nRaw = takeFlagValue(work, "--n");

  if (loadManifest() && !force) {
    console.error(`Local skills have already been mined on this machine.`);
    console.error(`Manifest: ${MANIFEST_PATH}`);
    console.error(`Pass --force to re-mine.`);
    process.exit(1);
  }

  const installs = detectInstalledAgents();
  if (installs.length === 0) {
    console.error(`No agent session directories detected. Run a session first.`);
    process.exit(1);
  }
  console.log(`Detected installed agents: ${installs.map(i => i.agent).join(", ")}`);

  const host = detectHostAgent();
  const fallback = installs[0].agent;
  const gateAgent = gateAgentFor(host, fallback, installs);
  // Fail fast when no supported gate is available. runGateViaStdin v1 only
  // implements the stdin-prompt path for claude_code; other agents hit the
  // synchronous "stdin gate runner only supports claude_code" rejection
  // inside every parallel call, producing a silent no-op (0 skills mined,
  // exit 0). Better to surface the constraint upfront with a concrete fix.
  if (gateAgent !== "claude_code") {
    console.error(`mine-local v1 requires the Claude Code CLI as its LLM gate.`);
    console.error(`Detected gate agent: ${gateAgent} (no claude_code session dir found at ~/.claude/projects/).`);
    console.error(`Install Claude Code, or run a Claude Code session once, then re-run.`);
    process.exit(1);
  }
  const gateBin = findAgentBin(gateAgent);
  console.log(`Gate CLI: ${gateAgent} (${gateBin})${host ? " — host-agent detected" : ""}`);

  const cwd = process.cwd();
  const rawSessions = listLocalSessions(installs, cwd);
  const now = Date.now();
  const allSessions = rawSessions.filter(s => now - s.mtime >= IN_FLIGHT_MAX_AGE_MS);
  const dropped = rawSessions.length - allSessions.length;
  const cwdCount = allSessions.filter(s => s.inCwd).length;
  console.log(`Found ${allSessions.length} local session(s) (${cwdCount} in cwd${dropped > 0 ? `, ${dropped} in-flight skipped` : ""})`);

  if (allSessions.length === 0) {
    console.error(`No mineable session files (all were modified within the last ${IN_FLIGHT_MAX_AGE_MS / 1000}s).`);
    process.exit(1);
  }

  const n = nRaw === "all"
    ? allSessions.length
    : nRaw
      ? Math.max(1, parseInt(nRaw, 10) || DEFAULT_N)
      : DEFAULT_N;

  const picked = pickSessions(allSessions, { n, epsilon: EPSILON });
  console.log(`Picking ${picked.length} session(s) (ε=${EPSILON}, N=${n}): ${picked.map(s => s.sessionId.slice(0, 8)).join(", ")}`);

  if (dryRun) {
    console.log(`Dry-run: would invoke ${gateAgent} gate on ${picked.length} session(s) in parallel (concurrency=${GATE_CONCURRENCY}).`);
    return;
  }

  const tmpDir = join(homedir(), ".claude", "hivemind", `mine-local-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  console.log(`Running ${picked.length} gate call(s) in parallel (concurrency=${GATE_CONCURRENCY}, timeout=${GATE_TIMEOUT_MS / 1000}s each)...`);

  const results = await parallelMap(picked, GATE_CONCURRENCY, async (s): Promise<SessionGateResult> => {
    const shortId = s.sessionId.slice(0, 8);
    const rows = nativeJsonlToRows(s.path, s.sessionId, s.agent);
    const pairs = extractPairs(rows);
    if (pairs.length === 0) {
      console.log(`  [${shortId}] no usable pairs — skipped`);
      return { session: s, skills: [], reason: "no pairs", error: null };
    }
    // Take the last PER_SESSION_PAIR_CAP pairs of the session (newest end).
    // Keep chronological order inside the gate prompt — newest-last is easier
    // for the model to reason about than reversed input.
    const tail = pairs.slice(-PER_SESSION_PAIR_CAP);

    const sessionTmp = join(tmpDir, `s-${shortId}`);
    mkdirSync(sessionTmp, { recursive: true });
    const verdictPath = join(sessionTmp, "verdict.json");
    const prompt = buildSessionPrompt(tail, s, verdictPath);
    writeFileSync(join(sessionTmp, "prompt.txt"), prompt);

    const gate = await runGateViaStdin({ agent: gateAgent, bin: gateBin, prompt, timeoutMs: GATE_TIMEOUT_MS });
    try {
      writeFileSync(join(sessionTmp, "gate-stdout.txt"), gate.stdout);
      if (gate.stderr) writeFileSync(join(sessionTmp, "gate-stderr.txt"), gate.stderr);
    } catch { /* ignore */ }

    if (gate.errored) {
      console.log(`  [${shortId}] gate failed: ${gate.errorMessage}`);
      return { session: s, skills: [], reason: null, error: gate.errorMessage ?? "gate failed" };
    }

    const verdictText = existsSync(verdictPath) ? readFileSync(verdictPath, "utf-8") : gate.stdout;
    const mv = parseMultiVerdict(verdictText);
    if (!mv) {
      console.log(`  [${shortId}] unparseable verdict (kept at ${sessionTmp})`);
      return { session: s, skills: [], reason: null, error: "unparseable verdict" };
    }
    console.log(`  [${shortId}] ${mv.skills.length} skill candidate(s) — ${mv.reason ?? "no reason given"}`);
    return { session: s, skills: mv.skills, reason: mv.reason ?? null, error: null };
  });

  // Per-candidate overlap check — NOT aggregation. Each session contributed
  // independently; we don't try to merge or pick winners. Instead, for each
  // candidate we ask: does its summary (description) overlap with any skill
  // already installed locally OR any skill already written earlier in this
  // run? If yes, skip it as a duplicate. If no, write it.
  //
  // Word-level Jaccard with a stopword filter is fast and good enough — the
  // gate names skills consistently for the same concept, so even when token
  // overlap is partial, summaries of true-duplicates share enough non-trivial
  // tokens to cross OVERLAP_THRESHOLD.
  const skillsRoot = resolveSkillsRoot("global", cwd);
  const totalCandidates = results.reduce((sum, r) => sum + r.skills.length, 0);
  const existingSummaries = loadExistingSummaries(skillsRoot);
  console.log("");
  console.log(`Got ${totalCandidates} candidate(s) across ${picked.length} session(s). Checking overlap against ${existingSummaries.length} installed skill(s) + each new write.`);

  if (totalCandidates === 0) {
    // Still persist an empty manifest so the file doubles as the one-shot
    // sentinel: without it, the SessionStart auto-spawn (maybeAutoMineLocal)
    // would re-fire on every new session because it gates on manifest
    // existence, not content. Equally, SessionStart's countLocalManifestEntries()
    // surface still reports a deterministic 0 instead of "no mining run yet".
    const existing = loadManifest();
    saveManifest({
      created_at: existing?.created_at ?? new Date().toISOString(),
      entries: existing?.entries ?? [],
    });
    console.log(`No skills to write.`);
    console.log(`tmp dir kept for inspection: ${tmpDir}`);
    return;
  }

  // Flatten — preserve session order so newest sessions get their candidates
  // considered first (so if two sessions disagree on the same skill, the
  // newer one's wording wins by being written first; the older one's
  // overlapping copy gets skipped).
  const flat: Array<{ skill: MinedSkill; session: SessionFile }> = [];
  for (const r of results) {
    for (const sk of r.skills) flat.push({ skill: sk, session: r.session });
  }
  flat.sort((a, b) => b.session.mtime - a.session.mtime);

  // Compute fan-out targets once: which non-Claude agent skill roots are
  // installed on this machine? We reuse the same detector + symlink helper
  // that `hivemind skillify pull` uses, so a mined skill ends up visible
  // to every agent (codex, hermes, pi via ~/.agents/skills/, ~/.hermes/skills/,
  // ~/.pi/agent/skills/). Cursor has no native skill discovery and is
  // intentionally excluded by detectAgentSkillsRoots.
  const fanOutRoots = detectAgentSkillsRoots(skillsRoot);
  if (fanOutRoots.length > 0) {
    console.log(`Fan-out targets: ${fanOutRoots.join(", ")}`);
  }

  const written: Array<{ skill: MinedSkill; session: SessionFile; result: { path: string; createdAt: string }; symlinks: string[] }> = [];
  const knownSummaries: Array<{ name: string; desc: string }> = [...existingSummaries];

  for (const { skill, session } of flat) {
    const overlap = findOverlap(skill.description, knownSummaries);
    if (overlap) {
      console.log(`  skipped ${skill.name} ← session ${session.sessionId.slice(0, 8)} (description overlaps "${overlap.name}", Jaccard=${overlap.score.toFixed(2)})`);
      continue;
    }
    try {
      const result = writeNewSkill({
        skillsRoot,
        name: skill.name,
        description: skill.description,
        trigger: skill.trigger,
        body: skill.body,
        sourceSessions: [session.sessionId],
        agent: gateAgent,
      });
      const canonicalDir = dirname(result.path);
      const symlinks = fanOutRoots.length > 0
        ? fanOutSymlinks(canonicalDir, basename(canonicalDir), fanOutRoots)
        : [];
      const symlinkSuffix = symlinks.length > 0 ? `, fan-out → ${symlinks.length} root(s)` : "";
      console.log(`  wrote ${skill.name} ← session ${session.sessionId.slice(0, 8)} (${session.agent}${symlinkSuffix})`);
      written.push({ skill, session, result, symlinks });
      knownSummaries.push({ name: skill.name, desc: skill.description });
    } catch (e: any) {
      if (/already exists/i.test(e.message ?? "")) {
        console.log(`  skipped ${skill.name} (file already exists at ${skillsRoot})`);
        // Don't add to knownSummaries — the existing one was already there
        // and either matched in loadExistingSummaries above (so we'd have
        // overlap-skipped instead) OR the existing skill's description was
        // empty / unparseable. Either way, no need to re-add here.
      } else {
        console.log(`  failed ${skill.name}: ${e.message}`);
      }
    }
  }

  if (written.length > 0) {
    const existing = loadManifest();
    const newEntries: ManifestEntry[] = written.map(({ skill, session, result, symlinks }) => ({
      skill_name: skill.name,
      canonical_path: result.path,
      symlinks,
      source_session_ids: [session.sessionId],
      source_session_paths: [session.path],
      source_agent: session.agent,
      gate_agent: gateAgent,
      created_at: result.createdAt,
      uploaded: false,
    }));
    saveManifest({
      created_at: existing?.created_at ?? new Date().toISOString(),
      entries: [...(existing?.entries ?? []), ...newEntries],
    });
  }

  console.log("");
  console.log(`Mined ${written.length} skill(s) from ${picked.length} session(s) (${results.filter(r => r.skills.length > 0).length} session(s) contributed candidate(s)).`);
  console.log(`Installed to ${skillsRoot}/ — local-only, not shared.`);
  console.log(`Sign in with 'hivemind login' to share with your team later.`);
}
