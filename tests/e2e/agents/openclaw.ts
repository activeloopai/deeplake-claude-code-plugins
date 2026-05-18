/**
 * OpenClaw driver.
 *
 * OpenClaw is a gateway plugin, not a CLI — there is no `openclaw -p <prompt>`.
 * The runtime that owns sessions, fires hook events, and routes tool calls is
 * the gateway server itself. Spinning up that server inside the e2e harness
 * is heavy infrastructure (separate process, port binding, settle time,
 * teardown choreography) and inappropriate for the fast cross-agent loop.
 *
 * Instead, this driver loads the INSTALLED plugin module from
 * `<tmpHome>/.openclaw/extensions/hivemind/dist/index.js` and exercises its
 * registered event handlers directly via a fake `pluginApi`. The plugin's
 * own code paths run end-to-end: SKILL.md injection (`before_prompt_build`),
 * capture INSERT (`agent_end`), skillify worker spawn, the works. What we
 * miss vs a real gateway: event ordering across multiple agents, the
 * gateway's own parsing of upstream messages, real concurrency with other
 * gateway operations.
 *
 * That's an acceptable trade-off: the plugin's *behavior* is what we want
 * cross-agent parity for; the gateway is a parallel surface that has its
 * own tests in the openclaw repo. Documented as a different driver shape
 * than the CLI drivers — see the comment block at the run() implementation.
 *
 * "Prompt" semantics for openclaw cases:
 *   - The prompt string is dropped into a synthetic user message inside
 *     a synthetic `agent_end` event payload. The plugin captures it the
 *     same way it would in a real session.
 *   - For tool-call cases (hivemind_search / hivemind_read / hivemind_index),
 *     the case sets a marker in opts and the driver dispatches to the
 *     corresponding registered tool instead of firing agent_end.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { installOrThrow } from "./install-via-cli.js";

// Marker prefix the harness uses to ask openclaw to invoke a specific tool
// instead of firing agent_end. Case file sets the prompt to one of these
// magic strings; runner.run() pivots on the prefix.
export const OPENCLAW_TOOL_PROMPT_PREFIX = "__OPENCLAW_TOOL__:";

interface CapturedLog {
  info: string[];
  error: string[];
}

interface FakePluginApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info?: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => void;
  registerCommand: (cmd: unknown) => void;
  registerTool: (tool: AgentTool) => void;
  registerMemoryCorpusSupplement: (supplement: unknown) => void;
}

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string | undefined,
    rawParams: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

export const openclawDriver: AgentDriver = {
  id: "openclaw",
  providerKey: null,
  async install(home, repoRoot) {
    await installOrThrow("claw", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const startedAt = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Mirror hivemind hooks' debug log convention so `hook-log-contains`
    // assertions work identically for openclaw and the CLI agents. The
    // installed plugin code writes via console / its own log path; we
    // capture both into a hook-debug.log file under the tmp HOME so the
    // assertion harness can grep it just like for the others.
    const logPath = join(opts.home, ".deeplake", "hook-debug.log");
    mkdirSync(join(opts.home, ".deeplake"), { recursive: true, mode: 0o700 });
    const writeLog = (line: string): void => {
      try { appendFileSync(logPath, line.endsWith("\n") ? line : `${line}\n`); }
      catch { /* best-effort */ }
    };
    writeLog(`[openclaw-e2e] session=${opts.sessionId}`);

    // HOME env override happens via process.env so the installed plugin's
    // own readFileSync / homedir() calls land in the tmp sandbox. The
    // installed module is brand-new in this process — no module cache
    // entry yet — so it picks up the override on first import.
    const previousHome = process.env.HOME;
    process.env.HOME = opts.home;
    process.env.HIVEMIND_DEBUG = "1";

    let exitCode = 0;
    const captured: CapturedLog = { info: [], error: [] };
    try {
      const pluginPath = resolve(opts.home, ".openclaw", "extensions", "hivemind", "dist", "index.js");
      // Cache-bust via query string. If a previous case in the same runner
      // already imported this path, Node's ESM cache would serve the stale
      // module; the URL suffix forces a fresh load.
      const cacheBuster = `?e2e=${Date.now()}-${randomUUID()}`;
      const pluginUrl = `file://${pluginPath}${cacheBuster}`;
      const mod = await import(pluginUrl) as { default: { register: (api: FakePluginApi) => unknown } };

      const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
      const tools = new Map<string, AgentTool>();
      const api: FakePluginApi = {
        pluginConfig: {},
        logger: {
          info: (...a) => { const s = a.map(String).join(" "); captured.info.push(s); stdout.push(s); writeLog(`[info] ${s}`); },
          error: (...a) => { const s = a.map(String).join(" "); captured.error.push(s); stderr.push(s); writeLog(`[error] ${s}`); },
        },
        on: (event, handler) => { handlers.set(event, handler); },
        registerCommand: () => { /* not needed for capture/tool e2e */ },
        registerTool: (tool) => { tools.set(tool.name, tool); },
        registerMemoryCorpusSupplement: () => { /* not needed */ },
      };

      // Plugin's top-level register() must be synchronous, but it kicks off
      // an async IIFE for the rest of the wiring (login, hooks). Wait long
      // enough for the IIFE to register the agent_end + tools before we
      // fire events. Empirically ~500ms is sufficient when the plugin only
      // needs to load already-imported chunks.
      mod.default.register(api);
      await new Promise((r) => setTimeout(r, 1500));

      if (prompt.startsWith(OPENCLAW_TOOL_PROMPT_PREFIX)) {
        // Tool-call shape: "__OPENCLAW_TOOL__:<tool_name>:<json_args>"
        const payload = prompt.slice(OPENCLAW_TOOL_PROMPT_PREFIX.length);
        const colon = payload.indexOf(":");
        const toolName = colon === -1 ? payload : payload.slice(0, colon);
        const rawArgs = colon === -1 ? "{}" : payload.slice(colon + 1);
        const tool = tools.get(toolName);
        if (!tool) {
          stderr.push(`[harness] openclaw plugin did not register a tool named '${toolName}'`);
          exitCode = 1;
        } else {
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          const result = await tool.execute(`e2e-${randomUUID()}`, args);
          for (const block of result.content) stdout.push(block.text);
        }
      } else {
        // Capture shape: fire a synthetic agent_end event with the prompt
        // as a user message + a canned assistant response. Mirrors the
        // payload openclaw's real gateway emits on session end.
        const agentEnd = handlers.get("agent_end");
        if (!agentEnd) {
          stderr.push("[harness] openclaw plugin did not register agent_end handler");
          exitCode = 1;
        } else {
          await agentEnd({
            success: true,
            session_id: opts.sessionId,
            channel: "openclaw-e2e",
            messages: [
              { role: "user", content: prompt },
              { role: "assistant", content: `[e2e simulated assistant response for case]` },
            ],
          });
        }
      }
    } catch (e: unknown) {
      exitCode = 1;
      stderr.push(`[openclaw-e2e] driver threw: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    return {
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      exitCode,
      sessionId: opts.sessionId,
      costCents: 0, // no model call — driver fires plugin code directly
      durationMs: Date.now() - startedAt,
    };
  },
};

// Helper used by openclaw-only cases (see cases/08-openclaw-tools.ts) to
// build the magic prompt string. Cases call it for ergonomics, but any
// case can construct the string directly.
export function buildOpenclawToolPrompt(toolName: string, args: Record<string, unknown>): string {
  return `${OPENCLAW_TOOL_PROMPT_PREFIX}${toolName}:${JSON.stringify(args)}`;
}
