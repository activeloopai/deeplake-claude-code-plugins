# Summaries

Hivemind doesn't just capture raw events — it also generates an **AI-written wiki summary** for each session and stores it in the `memory` table (alongside its 768-dim `summary_embedding`). The summary is what shows up when you `Grep` for past sessions or follow links from `~/.deeplake/memory/index.md`.

## When summaries are written

Each agent (Claude Code / Codex / Cursor / Hermes / pi) fires a wiki worker on two triggers:

| Trigger           | When it fires                                                                 |
|-------------------|-------------------------------------------------------------------------------|
| **Final**         | At session end (Stop / SessionEnd / session_shutdown), once.                  |
| **Periodic**      | Mid-session, when **either** of two thresholds is hit since the last summary: |
|                   | • messages-since-last-summary ≥ `HIVEMIND_SUMMARY_EVERY_N_MSGS` (default 50)  |
|                   | • elapsed time ≥ `HIVEMIND_SUMMARY_EVERY_HOURS` (default 2)                   |

The first message after a long pause therefore triggers a fresh summary; long sessions naturally checkpoint every ~50 messages.

A per-session JSON sidecar at `~/.claude/hooks/summary-state/<sessionId>.json` tracks `{lastSummaryAt, lastSummaryCount, totalCount}`. The dir is shared across all agents (session ids are UUIDs so no collisions). It is **never deleted**, so resuming a session via `--resume` / `--continue` picks up where it left off.

## How a summary is generated

1. The wiki worker queries the `sessions` table for every event tied to that session.
2. It builds a structured prompt asking the host agent's CLI to extract entities, decisions, files modified, open questions, etc.
3. It shells out to that agent's CLI (`claude -p`, `codex exec`, `pi --print`, …) with the prompt — never a separate API key, the agent's existing credentials are used.
4. The generated markdown is uploaded to the `memory` table at `/summaries/<user>/<sessionId>.md`. The shared embedding daemon produces the 768-dim `summary_embedding` so the summary is recallable via semantic search.

A lock file at `~/.claude/hooks/summary-state/<sessionId>.lock` prevents two workers from running concurrently for the same session.

## Configuration

| Env var                            | Default        | Effect                                              |
|------------------------------------|----------------|-----------------------------------------------------|
| `HIVEMIND_SUMMARY_EVERY_N_MSGS`    | `50`           | Trigger periodic when messages-since-last ≥ this    |
| `HIVEMIND_SUMMARY_EVERY_HOURS`     | `2`            | Trigger periodic after this many hours, with ≥1 msg |
| `HIVEMIND_CURSOR_MODEL`            | `auto`         | (cursor only) model passed to `cursor-agent --print --model` |
| `HIVEMIND_HERMES_PROVIDER`         | `openrouter`   | (hermes only) provider passed to `hermes -z --provider` |
| `HIVEMIND_HERMES_MODEL`            | `anthropic/claude-haiku-4-5` | (hermes only) model passed to `hermes -z -m` |
| `HIVEMIND_PI_PROVIDER`             | `google`       | (pi only) provider passed to `pi --print --provider`|
| `HIVEMIND_PI_MODEL`                | `gemini-2.5-flash` | (pi only) model passed to `pi --print --model` |
| `HIVEMIND_CAPTURE=false`           | unset          | Disable both capture and summary generation         |

For pi specifically, the wiki worker is bundled separately at `~/.pi/agent/hivemind/wiki-worker.js` (deposited by `hivemind pi install`). The other agents ship the wiki worker inside their per-agent plugin bundle.
