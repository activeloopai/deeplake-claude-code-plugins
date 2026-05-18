# Per-agent SessionStart delivery channels

> **What this file is and why it lives here.** This is not runtime documentation — it's a record of the empirical research that informed the v1 Claude Code adapter and what each future agent integration will need. When we wire up openclaw / codex / cursor / hermes / pi as real consumers (one at a time, based on usage), the implementer will need to know what each agent's harness does with hook stdout / stderr / JSON shapes. Re-discovering this from scratch costs an hour-plus per agent; preserving the findings here is the cheapest way to amortize that work across the team. If the file ever drifts from reality, update it; if it stops being useful, delete it.

Research notes on each agent's harness behavior — what stdout / stderr / JSON shapes get rendered to the user vs the model. Findings come from source-level reading of each agent's harness (`~/.hermes/hermes-agent/...`, `openai/codex@main`, etc.) plus an empirical probing session against Claude Code 2.1.131 (the probes themselves are no longer in-tree — they were 50-line scripts that emitted unique markers per channel and were trivial to recreate when needed).

## Current implementation status

**Claude Code uses the `delivery/claude-code.ts` adapter via the notifications framework. Codex emits the same `systemMessage` JSON shape directly from its own session-start hook (no shared adapter — it's a per-hook concern, not a framework concern).** Other agents either lack a user-visible channel entirely (Cursor, Pi) or are blocked by upstream bugs (Hermes).

| Agent | User-visible CTA shipped? | How | Roadmap |
|---|---|---|---|
| Claude Code | ✅ `delivery/claude-code.ts` via notifications framework (dual-channel JSON) | `systemMessage` + nested `hookSpecificOutput.additionalContext` | shipped |
| Codex | ✅ in `src/hooks/codex/session-start.ts` directly | `systemMessage` + nested `hookSpecificOutput.additionalContext` | shipped |
| Cursor | ❌ — Cursor's `sessionStart` hook API does not expose a user-visible channel (only `env` + `additional_context`) | model-visible only | not feasible without upstream change |
| Hermes | ❌ — upstream bug: `on_session_start` return value discarded at `run_agent.py:9777-9786` | nothing surfaces | needs `pre_llm_call` migration or upstream fix |
| Pi | ❌ — extension API has no user-visible session-start channel | model-visible via the extension's own context injection | not feasible without upstream change |
| openclaw | TBD — research before implementing | TBD | TBD |

When a new adapter lands: add the agent string to the `Agent` union in `types.ts`, create `delivery/<agent>.ts`, wire it into the dispatch table in `delivery/index.ts`. The notes below tell you exactly what shape each agent's harness needs.

## TL;DR — per-agent harness behavior

| Agent | Multi-hook → distinct context blocks? | Stderr → user? | User-visible JSON field | Recommended delivery shape |
|---|---|---|---|---|
| **Claude Code** | ✅ YES — additionalContext from each hook collected into an array | ❌ stderr captured but NOT rendered as of CC 2.1.131 — use `systemMessage` instead | ✅ top-level `systemMessage` → renders as `SessionStart:startup says: <text>` | dual-channel JSON: top-level `systemMessage` (user-visible) + nested `hookSpecificOutput.additionalContext` (model-visible) |
| **Codex** | ❌ NO — flattened `Vec<String>`, joined with `\n\n` downstream | ❌ NO — discarded | ✅ top-level `systemMessage` (since 0.130.0, schema-strict) → renders as `warning: <text>` inside `• SessionStart hook (completed)` history cell after the first turn | dual-channel JSON: top-level `systemMessage` + nested `hookSpecificOutput.additionalContext`. `#[serde(deny_unknown_fields)]` on the wire type means ANY unknown field fails the parse → falls back to plain-text into additional_context (silent loss of `systemMessage`). |
| **Hermes** | ❌ NO — `on_session_start` return value DISCARDED entirely at `run_agent.py:9777-9786` | ❌ NO — captured to `logger.debug` only | ❌ none | register a `pre_llm_call` hook with framework-side per-`session_id` dedup (fire only on first turn) |
| **Cursor** | ⚠️ docs imply concat into `additional_context` | ⚠️ Unknown | ❌ none — only `env` + `additional_context` per cursor.com docs (May 2026) | model-visible only via `additional_context` |
| **openclaw** | TBD — research before implementing | TBD | TBD | TBD |

## Findings (source-level)

### Claude Code — verified empirically against 2.1.131 with multi-channel probe

A standalone shell-script probe was wired in as a 2nd SessionStart hook command alongside the existing memory hook. The probe emitted distinct markers via every plausible channel; the user opened a fresh `claude` and reported what surfaced. The session JSONL was inspected to see exactly how the harness recorded each.

Findings:
- ✅ **Top-level `systemMessage` → user-visible verbatim.** Renders in the terminal at session start as `SessionStart:startup says: <text>`. MUST be at the top level of the JSON; nesting it inside `hookSpecificOutput` causes the harness to silently drop it.
- ✅ **Nested `hookSpecificOutput.additionalContext` → model-visible.** Multiple hooks' additionalContext arrive as an array on a single `hook_additional_context` attachment — both the existing memory hook's content AND our notification hook's content are present.
- ❌ **`process.stderr.write` → captured but not rendered.** As of Claude Code 2.1.0 ("ultrathink update"), SessionStart hook stderr is recorded into the session JSONL's `attachment.stderr` field but no longer printed to the user's terminal. Don't rely on it.
- ❌ **Top-level `additionalContext` (not nested) → ignored.** The docs and our test confirm only the nested form is honored.

Empirical evidence preserved in the session JSONL captured by the probe — see also CC docs ([Hooks reference](https://code.claude.com/docs/en/hooks)) and bug reports [#9591](https://github.com/anthropics/claude-code/issues/9591) (post-2.1.0 silenced stderr) and [#15344](https://github.com/anthropics/claude-code/issues/15344) (systemMessage behavior in CLI vs VS Code).

**Channel (v1):** single SessionStart hook command emits one JSON object with `systemMessage` at top level + `hookSpecificOutput.additionalContext` nested. Same text in both. User reads, model reasons.

**Caveat:** the VS Code extension does not render `systemMessage` (issue #15344). Terminal CLI users get the full UX; IDE users get model-only delivery.

### Codex — verified empirically against 0.130.0 + upstream source (`openai/codex@main`)

**This section was wrong in the first pass** — the original research was done against an older Codex (~0.118.0) when JSON output was rejected entirely and stdout was always treated as plain text. As of 0.130.0 the wire schema accepts a full hook output object:

- `codex-rs/hooks/src/schema.rs::HookUniversalOutputWire` is `#[serde(rename_all = "camelCase")]` + `#[serde(deny_unknown_fields)]` with fields `continue`, `stopReason`, `suppressOutput`, **`systemMessage`** (Option<String>).
- `codex-rs/hooks/src/schema.rs::SessionStartCommandOutputWire` flattens the universal output and adds `hookSpecificOutput` containing `{ hookEventName: "SessionStart", additionalContext }`.
- `codex-rs/hooks/src/events/session_start.rs::parse_completed`:
  - JSON parse success → if `system_message` is present, push `HookOutputEntry { kind: Warning, text: system_message }`; if `additional_context` is present, push it as `Context` and into `additional_contexts_for_model`.
  - JSON parse failure but `looks_like_json` → mark `HookRunStatus::Failed` with an Error entry "hook returned invalid session start JSON output".
  - Plain text fallback → whole stdout goes into `additional_context` (model-visible only — `systemMessage` is silently lost).
- `codex-rs/tui/src/history_cell/hook_cell.rs` renders Warning entries with prefix `"warning: "`, Context entries with `"hook context: "`. The hook bullet `• SessionStart hook (completed)` appears in the conversation history **after the first user prompt** (no rendering on the empty splash screen).
- `parse_completed()` only reads stdout; `result.stderr` field exists but is never inspected — **stderr discarded**.

**Hook execution requires both:**
1. `[features].hooks = true` in `config.toml` (or `--enable hooks` flag). The legacy `[features].codex_hooks = true` is deprecated as of 0.130.0 and prints a warning. Without either, hooks are silently disabled.
2. Per-hook approval: codex computes a `sha256` of the hook command + writes a `[hooks.state."<path>:<event>:<idx>:<idx>"]` trusted_hash entry in `config.toml`. Users approve unapproved hooks via `/hooks` in the TUI. Until approved, a `⚠ N hooks need review before they can run` banner appears and the hook is skipped.

**Verified live** with the `localMinedRule` injection: rendering produces

```
• SessionStart hook (completed)
  warning: 💡 5 skills mined from your local sessions live in ~/.claude/skills/. Run 'hivemind login' to share them with your team.
  hook context: DEEPLAKE MEMORY: ...
```

**v1 implication:** Codex has the SAME systemMessage user-visible channel as Claude Code. `src/hooks/codex/session-start.ts` was migrated from plain-text stdout to JSON output mirroring CC's dual-channel shape. No shared `delivery/codex.ts` adapter needed — the hook itself emits the JSON.

### Hermes — verified upstream source (`~/.hermes/hermes-agent/`)

- `run_agent.py:9777-9786`: `_invoke_hook("on_session_start", ...)` is called but its return value is **discarded** — no assignment, no use of the returned `List[Any]`.
- The current shipping `src/hooks/hermes/session-start.ts:109` line `console.log(JSON.stringify({ context: additional }))` is a **latent no-op** — bytes travel through stdin/stdout/parse and get dropped at the caller. Worth filing upstream.
- `agent/shell_hooks.py:391-398` runs hooks with `subprocess.run(..., capture_output=True, ...)`, then `:444-448` routes stderr to `logger.debug(...)` only — stderr is captured and only emitted at DEBUG log level (default INFO/WARNING; user must explicitly opt in via `--dev` or `HERMES_LOG_LEVEL=DEBUG`).
- The actual model-visible context-injection point in Hermes is `pre_llm_call` (`run_agent.py:9890-9897`), where multiple callbacks' `{context: "..."}` returns are joined with `"\n\n"`.
- **v1 implication:** Hermes cannot deliver a notification at session start through the existing `on_session_start` hook channel. Future option: register a `pre_llm_call` hook with framework-side `session_id`-keyed dedup (fire only on first turn of each session). Out of scope for v1.

### Cursor — closed source

- `~/.cursor/hooks.json` accepts an array of commands per `sessionStart` — config shape supports multiple hooks.
- Cursor 1.7+ docs describe `additional_context` as a single string field. Docs are silent on multi-hook merging behavior and stderr handling. No source available to verify.
- **Implementation note:** behavior unknown; verify via the runnable probe in `probe/probe-cursor.js` before implementing.

## v1 delivery summary

The only agent shipped today is **Claude Code**, via a dual-channel JSON emit:

- **`systemMessage` at the top level** of the JSON output — renders verbatim in the terminal as `SessionStart:startup says: <text>`. User-visible.
- **`hookSpecificOutput.additionalContext`** (nested) — delivered to the model as a `<system-reminder>` block. Lets the model reason on follow-up turns ("you have a balance reminder, avoid expensive ops?").

Both fields carry the same rendered text. The user definitely sees it; the model also receives it.

Other agents (Codex, Cursor, Hermes, Pi, openclaw) are not yet wired. The findings above are the forward reference for what each adapter needs to do when it's prioritized.

## Probes

`probe/` contains runnable verification scripts for each agent. They no-op unless `HIVEMIND_NOTIFICATION_PROBE=1` is set. See `probe/README.md` for wiring instructions. Phase 0 closed without running them in live Codex/Cursor/Hermes sessions because the source-level read already established that multi-hook block separation is not a viable strategy for those agents.
