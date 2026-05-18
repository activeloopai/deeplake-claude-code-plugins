/**
 * Shared types for the cross-agent E2E harness.
 *
 * The harness drives N real agent CLIs through M behavioral cases. Each
 * (case, agent) tuple is one test point. Drivers know how to spawn one
 * agent; cases know what assertions hold for one behavior. The runner
 * orchestrates the matrix.
 *
 * Keep this file tiny and dependency-free — every module in the harness
 * imports it, and circular deps here will haunt later.
 */

export type AgentId =
  | "claude-code"
  | "codex"
  | "cursor-agent"
  | "hermes"
  | "pi"
  | "openclaw";

/**
 * Which provider env var an agent's spawn requires. `null` means the
 * driver runs without a model call (e.g. openclaw fires hook events
 * programmatically against its registered handlers — no LLM in the
 * loop). The runner uses this to decide whether a missing key is a
 * skip or doesn't apply at all.
 */
export type ProviderKey = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | null;

/**
 * One agent driver — knows how to install hivemind into a sandboxed HOME
 * and spawn the underlying CLI with a prompt. Assertions are NOT a driver
 * concern; the runner reads them off the case and executes them after.
 */
export interface AgentDriver {
  id: AgentId;
  /**
   * Provider env var this driver's run() requires. Null means run() does
   * not call any LLM — typically because the "agent" is a plugin host
   * (openclaw) whose driver fires registered hook handlers programmatically
   * instead of spawning a binary.
   */
  providerKey: ProviderKey;
  /**
   * One-shot auth precheck. Called once per matrix run BEFORE any of this
   * agent's cases fire. Returns null if the agent CLI looks authenticated
   * and ready to spawn; returns a short failure reason string if not (which
   * the runner uses to clean-skip ALL of this agent's cases with one
   * descriptive `[skip] <reason>` line instead of N copy-pasted stack
   * traces). Drivers that don't need an auth check (openclaw) can omit.
   */
  precheck?(): Promise<{ ready: true } | { ready: false; reason: string }>;
  /**
   * Install hivemind hooks into the given (tmp) HOME. For agents that
   * support a session-only plugin flag (e.g. `claude --plugin-dir`), this
   * may be a no-op and the flag is set in run() instead.
   */
  install(home: string, repoRoot: string): Promise<void>;
  /**
   * Spawn the CLI with the prompt (or, for openclaw, fire a synthetic
   * agent_end event whose user message contains the prompt text). Capture
   * stdout/stderr/exitCode/duration. Driver MUST set HOME=home for any
   * subprocess it spawns. Driver MAY parse a cost line from stdout into
   * `costCents` — null is acceptable when the agent doesn't print cost
   * (or never makes a model call).
   */
  run(prompt: string, opts: RunOpts): Promise<RunResult>;
  /**
   * Optional teardown. Most agents have no cleanup beyond rm -rf HOME,
   * which the runner does. Use only when the agent left state OUTSIDE the
   * sandboxed HOME (e.g. a global config file).
   */
  cleanup?(home: string): Promise<void>;
}

export interface RunOpts {
  home: string;
  repoRoot: string;
  /** session_id to write into the credentials sidecar / propagate downstream */
  sessionId: string;
  /** Provider keys to forward into the spawned process. Driver picks what it needs. */
  providerEnv: ProviderEnv;
  /** Hard wall-clock cap on the spawn. Defaults to 90s per case. */
  timeoutMs?: number;
}

export interface ProviderEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sessionId: string;
  costCents: number | null;
  durationMs: number;
}

/**
 * One behavioral case the matrix asserts on. Cases are agent-agnostic —
 * the same prompt + assertions run against every driver (unless skipFor
 * names the agent explicitly with a comment).
 */
export interface E2ECase {
  id: string;
  description: string;
  prompt: string;
  /**
   * Optional pre-run hook — e.g. seed a row in the memory table so the
   * agent has something to retrieve. Receives the tmp HOME + a configured
   * DeeplakeApi instance.
   */
  setup?: (ctx: CaseContext) => Promise<void>;
  assertions: Assertion[];
  /** Agents this case can't reach (with rationale in a comment next to the entry). */
  skipFor?: AgentId[];
  /**
   * When true, the runner does NOT call driver.run() — it only runs
   * driver.install() + case.setup() and then evaluates assertions
   * against the post-install filesystem / DB state. Use this for
   * install-shape cases that assert on side effects of the installer
   * itself (e.g. "settings.json doesn't contain references to files
   * that don't exist"). No model API call, no per-agent prompt cost.
   */
  installOnly?: boolean;
}

export interface CaseContext {
  home: string;
  sessionId: string;
  agent: AgentId;
  /** Test creds for the e2e workspace. Drivers + setup share this. */
  creds: TestCredentials;
}

export interface TestCredentials {
  apiUrl: string;
  token: string;
  orgId: string;
  orgName?: string;
  workspaceId: string;
  /** sessions table name in the e2e workspace. */
  sessionsTable: string;
  /** memory table name in the e2e workspace. */
  memoryTable: string;
}

/**
 * Assertion vocabulary, intentionally narrow for v1. LLM-as-judge is
 * deferred — plugin side-effect tests don't need it. Each assertion gets
 * the case context + the agent's run result + a query helper bound to the
 * test workspace.
 */
export type Assertion =
  | StdoutContainsAssertion
  | StdoutMatchesAssertion
  | SelectFromDbAssertion
  | HookLogContainsAssertion
  | CustomAssertion;

export interface StdoutContainsAssertion {
  type: "stdout-contains";
  /** Substring the agent's stdout MUST contain after the run. */
  substring: string;
  /** Optional label for the failure message; defaults to `substring`. */
  label?: string;
}

export interface StdoutMatchesAssertion {
  type: "stdout-matches";
  regex: RegExp;
  label?: string;
}

export interface SelectFromDbAssertion {
  type: "select-from-db";
  /** SQL to run against the test workspace. Use `${sid}` for the session_id placeholder. */
  sql: (ctx: AssertionContext) => string;
  /** Throws if the returned rows don't match expectations. */
  expect: (rows: Array<Record<string, unknown>>) => void;
  label?: string;
}

export interface HookLogContainsAssertion {
  type: "hook-log-contains";
  /** Substring that must appear in ${home}/.deeplake/hook-debug.log after the run. */
  substring: string;
  label?: string;
}

/**
 * Escape hatch for assertions that don't fit the four typed shapes.
 * Returns null on pass, or a failure-reason string on fail. Use this
 * sparingly — typed assertions document intent better — but it's
 * essential for install-shape cases that walk agent-specific config
 * file structures (no two agents have the same hooks-file layout).
 */
export interface CustomAssertion {
  type: "custom";
  check: (actx: AssertionContext) => Promise<string | null>;
  label: string;
}

export interface AssertionContext {
  ctx: CaseContext;
  run: RunResult;
}

export interface MatrixResult {
  case: string;
  agent: AgentId;
  passed: boolean;
  /** Reason for failure, or null on pass. */
  failure: string | null;
  costCents: number | null;
  durationMs: number;
  sessionId: string;
}
