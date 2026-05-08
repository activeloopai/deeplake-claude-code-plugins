<h1 align="center">
  <br>
  <a href="https://github.com/activeloopai/hivemind">
    <img src="https://raw.githubusercontent.com/activeloopai/hivemind/main/docs/public/hivemind-logo.svg" alt="Hivemind" width="120">
  </a>
  <br>
  Hivemind
  <br>
</h1>

<h4 align="center">One brain for all your agents</h4>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node"></a>
  <a href="https://deeplake.ai"><img src="https://img.shields.io/badge/Powered%20by-Deeplake-orange.svg" alt="Deeplake"></a>
</p>

<p align="center">
  Auto-learning, cloud-backed shared brain for <b>Claude Code • OpenClaw • Codex • Cursor • Hermes • pi</b> agents.<br>
</p>

> One engineer's agent figures out a tricky migration on Monday.
>
> Tuesday, every agent on the team can execute the pattern.

**Beyond memory.** Hivemind captures every coding-agent interaction in your org as a structured trace, codifies repeated patterns into reusable skills, and propagates those skills to every agent on your team. Repeat work stops being repeat work — senior engineers' breakthroughs become every junior engineer's starting point, and your org's accumulated engineering capability survives turnover, onboarding cycles, and tool changes.

- 📥 **Captures** every session's prompts, tool calls, and responses as structured traces in Deeplake
- 🧠 **Codifies** patterns in those traces into reusable skills, available to every agent on your team
- 🔍 **Searches** across all traces and skills with lexical retrieval (grep fallback when index unavailable)
- 🔗 **Propagates** capability across sessions, agents, teammates, and machines in real time
- 📁 **Intercepts** file operations on `~/.deeplake/memory/` through a virtual filesystem backed by SQL
- 📝 **Summarizes** sessions into AI-generated wiki pages via a background worker at session end

## Quick start

One command, all your agents:

```bash
npm install -g @deeplake/hivemind && hivemind install
```

That's it. The installer detects every supported assistant on your machine (Claude Code, Codex, OpenClaw, Cursor, Hermes Agent, pi), wires up the hooks, and opens a browser once for login. Restart your assistants and they all share the same brain.

**Install for a specific assistant only:**

```bash
hivemind install --only claude
hivemind claude install    # equivalent
hivemind codex install
hivemind claw install
hivemind cursor install
hivemind hermes install
hivemind pi install
```

**Check what's wired up:**

```bash
hivemind status
```

**Supported assistants:**

| Platform         | Integration                                      | Auto-capture | Auto-recall |
|------------------|--------------------------------------------------|--------------|-------------|
| **Claude Code**  | Marketplace plugin                               | ✅           | ✅          |
| **OpenClaw**     | Native extension                                 | ✅           | ✅          |
| **Codex**        | Hooks (`hooks.json`)                             | ✅           | ✅          |
| **Cursor**       | Hooks (`hooks.json` 1.7+)                        | ✅           | ✅          |
| **Hermes Agent** | Shell hooks (`config.yaml`) + skill + MCP server | ✅           | ✅          |
| **pi**           | Extension API (`pi.on(...)`) + skill + AGENTS.md | ✅           | ✅          |

### Alternative install paths

<details>
  <summary><b>Claude Code plugin marketplace</b></summary>

If you prefer Claude Code's native plugin marketplace:

```
/plugin marketplace add activeloopai/hivemind
/plugin install hivemind
/reload-plugins
/hivemind:login
```

Auto-updates on each session start. Manual update: `/hivemind:update`.
</details>

<details>
  <summary><b>OpenClaw ClawHub</b></summary>

```
openclaw plugins install clawhub:hivemind
```

Then type `/hivemind_login` in chat, click the auth link, and sign in.

#### Commands

| Command | Description |
|---------|-------------|
| `/hivemind_login` | Sign in via device flow |
| `/hivemind_capture` | Toggle capture on/off |
| `/hivemind_whoami` | Show current org and workspace |
| `/hivemind_orgs` | List organizations |
| `/hivemind_switch_org <name>` | Switch organization |
| `/hivemind_workspaces` | List workspaces |
| `/hivemind_switch_workspace <id>` | Switch workspace |
| `/hivemind_update` | Check for plugin updates |

Auto-recall and auto-capture are enabled by default. Data is stored in the same `sessions` table as Claude Code and Codex.

#### Coexistence with `memory-core`

Hivemind runs **alongside** OpenClaw's built-in `memory-core` plugin. It does **not** claim the memory slot, so `memory-core`'s dreaming cron (`"0 3 * * *"`) and other memory-slot-dependent jobs keep working. Hivemind captures session activity and exposes its own commands; `memory-core` keeps owning recall/promotion/dreaming.

#### Troubleshooting

- **Hivemind seems slow or unresponsive.** Check the agent model in `~/.openclaw/openclaw.json` under `agents.defaults.model`. Hivemind makes many small tool calls per turn; a large reasoning model like Opus will feel sluggish. Recommended default: `anthropic/claude-haiku-4-5-20251001`.
- **`openclaw model <id>` says "plugins.allow excludes model".** The `model` plugin CLI is disabled by default. Edit `~/.openclaw/openclaw.json` directly (key `agents.defaults.model`) and restart the gateway: `systemctl --user restart openclaw-gateway.service`.
- **Model switch rejected as "not allowed".** Use the exact dated provider-prefixed ID (`anthropic/claude-haiku-4-5-20251001`, `anthropic/claude-sonnet-4-6`). Legacy IDs like `claude-3-5-haiku-latest` and unprefixed bare IDs are not on OpenClaw's allowlist.
- **Self-update via Telegram fails with "elevated is not available".** `tools.elevated.allowFrom` must include `telegram` before elevated commands work from that channel. Safer alternative: run the upgrade in a local shell with `openclaw plugins update hivemind`.
- **`npm error EACCES` during self-update.** OpenClaw was installed under a root-owned npm prefix (e.g. `/usr/lib/node_modules/openclaw`). Reinstall under a user-writable prefix, or run the update with appropriate privileges locally — not via a channel.
</details>

<details>
  <summary><b>Codex (manual)</b></summary>

Tell Codex to fetch and follow the install instructions:

```
Fetch and follow instructions from https://raw.githubusercontent.com/activeloopai/hivemind/main/codex/INSTALL.md
```

Or run the installer script directly:

```bash
git clone https://github.com/activeloopai/hivemind.git ~/.codex/hivemind
~/.codex/hivemind/codex/install.sh
```

Restart Codex to activate.
</details>

<details>
  <summary><b>Cursor (1.7+)</b></summary>

The unified installer wires six lifecycle events in `~/.cursor/hooks.json` — sessionStart, beforeSubmitPrompt, postToolUse, afterAgentResponse, stop, sessionEnd. Hooks fork a Node bundle at `~/.cursor/hivemind/bundle/` per event. Restart Cursor after install to load.

```bash
hivemind cursor install
```

Auto-capture is enabled the same way as Claude Code / Codex / OpenClaw.
</details>

<details>
  <summary><b>Hermes Agent</b></summary>

Wires shell hooks into `~/.hermes/config.yaml` (`pre_llm_call` / `post_tool_call` / `post_llm_call` / `on_session_end`) for auto-capture, drops the bundle at `~/.hermes/hivemind/bundle/`, registers the shared MCP server (`~/.hivemind/mcp/server.js`) under `mcp_servers.hivemind`, and installs an `agentskills.io`-compatible skill at `~/.hermes/skills/hivemind-memory/` for recall.

```bash
hivemind hermes install
```
</details>

<details>
  <summary><b>pi (badlogic/pi-mono coding-agent)</b></summary>

Upserts an idempotent BEGIN/END marker block into `~/.pi/agent/AGENTS.md` (auto-loaded every turn) and drops a TypeScript extension at `~/.pi/agent/extensions/hivemind.ts`. The extension subscribes to pi's lifecycle events (`session_start` / `input` / `tool_result` / `message_end`) for auto-capture and registers `hivemind_search`, `hivemind_read`, `hivemind_index` as first-class pi tools.

```bash
hivemind pi install
```

Note: no per-agent SKILL.md is dropped under `~/.pi/agent/skills/` — pi reads skills from both that directory AND the shared `~/.agents/skills/` location. If the codex installer has run on the same machine, pi picks up the hivemind skill from the shared `~/.agents/skills/hivemind-memory` symlink automatically. The AGENTS.md block plus the registered tools cover the action surface in either case.
</details>


### Uninstall

```bash
hivemind uninstall              # remove from every detected assistant
hivemind codex uninstall        # remove from one
```

## How it works

Capture is just the substrate. The interesting layer is what happens to those traces afterward.

**1. Trace capture.** Every interaction (prompts, tool calls, file reads, terminal commands, reasoning chains, final outputs) is captured automatically. No configuration. `HIVEMIND_CAPTURE=true` is the default — set it to `false` to opt out.

**2. Skill codification.** Hivemind detects repeated patterns across traces — the same kind of bug being fixed in different ways, the same migration shape being applied across services, the same architectural decision recurring — and codifies those patterns into skills. Codification is a mix of automatic detection (statistical pattern matching across the trace store) and LLM-assisted extraction (the [skilify worker](#skills-skilify) reviews candidate patterns and writes structured skill definitions). Workspace-level scoping keeps skills from leaking between teams.

**3. Skill propagation.** Codified skills flow into agent context at inference time, across every Hivemind-connected agent in your workspace. The agent your junior engineer used this morning is sharper because of what your senior engineer's agent figured out last week.

**4. Compounding capability.** Week 1, your agents stop repeating mistakes. Month 1, they're learning from each other. Quarter 1, your engineering org operates with capability that survives team changes and onboarding cycles.

```
┌─────────────────────────────────────────────────────┐
│              Your Coding Agents                     │
│   Claude Code · Codex · OpenClaw · Cursor · ...     │
└──────────────────────────┬──────────────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  📥 Trace capture (every turn)      │
        │  prompts · tool calls · responses   │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🧠 Skill codification              │
        │  pattern detection · LLM extraction │
        │  workspace-scoped                   │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🔗 Skill propagation               │
        │  injected into agent context        │
        │  every agent · every teammate       │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  🌊 Deeplake                        │
        │  Tensor storage · Postgres · S3     │
        └─────────────────────────────────────┘
```

Every session compounds. Every agent levels up. Teammates in the same org draw from the same accumulated capability.

## Features

### 🔍 Natural search

Just ask your agent naturally:

```
"What was Emanuele working on?"
"Search traces for authentication bugs we've solved"
"What did we decide about the API design?"
"Show me skills my team has codified for handling migrations"
```

### 📝 AI-generated session summaries

After each session, a background worker generates a wiki summary: key decisions, code changes, next steps. Browse them at `~/.deeplake/memory/summaries/`.

### 👥 Team sharing

Invite teammates to your Deeplake org. Their agents draw from your team's traces and skills; your agents draw from theirs. No setup, no sync, no merge conflicts.

### 🔒 Privacy controls

Disable capture entirely:

```bash
HIVEMIND_CAPTURE=false claude
```

Enable debug logging:

```bash
HIVEMIND_DEBUG=1 claude
```

## ⚠️ Data collection notice

This plugin captures session activity and stores it in your Deeplake workspace:

| Data                  | What's captured                    |
|-----------------------|------------------------------------|
| User prompts          | Every message you send             |
| Tool calls            | Tool name + full input             |
| Tool responses        | Full tool output                   |
| Assistant responses   | The agent's final response         |
| Subagent activity     | Subagent tool calls and responses  |
| Codified skills       | Patterns extracted from traces     |

**All users in your Deeplake workspace can read this data.** That's the design — shared capability requires shared substrate. A DATA NOTICE is displayed at the start of every session. Workspace-level isolation prevents data leakage between orgs.

## Configuration

| Variable                  | Default                   | Description                                |
|---------------------------|---------------------------|--------------------------------------------|
| `HIVEMIND_TOKEN`          | —                         | API token (auto-set by login)              |
| `HIVEMIND_ORG_ID`         | —                         | Organization ID (auto-set by login)        |
| `HIVEMIND_WORKSPACE_ID`   | `default`                 | Workspace name                             |
| `HIVEMIND_API_URL`        | `https://api.deeplake.ai` | API endpoint                               |
| `HIVEMIND_TABLE`          | `memory`                  | SQL table for summaries and virtual FS     |
| `HIVEMIND_SESSIONS_TABLE` | `sessions`                | SQL table for per-event session capture    |
| `HIVEMIND_MEMORY_PATH`    | `~/.deeplake/memory`      | Path that triggers interception            |
| `HIVEMIND_CAPTURE`        | `true`                    | Set to `false` to disable capture          |
| `HIVEMIND_EMBEDDINGS`     | `true`                    | Set to `false` to force lexical-only mode  |
| `HIVEMIND_DEBUG`          | —                         | Set to `1` for verbose hook debug logs     |

## Optional: enable semantic search (embeddings)

Hivemind can run a local embedding daemon (nomic-embed-text-v1.5, ~130 MB)
so that `Grep` over `~/.deeplake/memory/` uses hybrid semantic + lexical
ranking instead of pure BM25. This is **off by default** — the daemon
depends on `@huggingface/transformers`, which pulls onnxruntime-node and
sharp (~600 MB total with native binaries). Shipping that with every agent
install would 60× the install size for a feature most users don't need.

To enable, run the bundled command:

```bash
hivemind embeddings install
```

This installs `@huggingface/transformers` **once** into a shared directory
(`~/.hivemind/embed-deps/`) and symlinks every detected agent's plugin to
it, so the 600 MB cost is paid one time regardless of how many agents you
have wired up. Re-run the same command after installing a new agent and
the new symlink is added (the npm install is skipped because it's cached).

Or do it in one shot at install time:

```bash
hivemind install --with-embeddings           # all detected agents
hivemind <agent> install --with-embeddings   # a single agent
```

Other commands:

```bash
hivemind embeddings status              # show shared deps + per-agent state
hivemind embeddings uninstall           # remove the per-agent symlinks
hivemind embeddings uninstall --prune   # also delete the shared dir (~600 MB)
```

Restart your agents after enabling. From the next session, captured
messages and AI-generated summaries will include a 768-dim embedding,
and semantic recall queries will route through the local daemon (the
nomic model is downloaded on first use and cached in `~/.cache/huggingface/`).

If `@huggingface/transformers` is **not** present, Hivemind silently
degrades to lexical-only mode:

- ✅ Capture continues; rows still land in Deeplake.
- ✅ `Grep` still works via BM25 / `ILIKE` matching on text columns.
- ⚪ The `message_embedding` / `summary_embedding` columns stay `NULL`.
- ⚪ The hook log notes `embeddings: no-transformers` once at session start.

You can also force lexical-only mode explicitly with
`HIVEMIND_EMBEDDINGS=false` (useful for CI or air-gapped environments).

## Summaries

Hivemind doesn't just capture raw events — it also generates an
**AI-written wiki summary** for each session and stores it in the
`memory` table (alongside its 768-dim `summary_embedding`). The summary
is what shows up when you `Grep` for past sessions or follow links from
`~/.deeplake/memory/index.md`.

### When summaries are written

Each agent (Claude Code / Codex / Cursor / Hermes / pi) fires a wiki
worker on two triggers:

| Trigger           | When it fires                                                                 |
|-------------------|-------------------------------------------------------------------------------|
| **Final**         | At session end (Stop / SessionEnd / session_shutdown), once.                  |
| **Periodic**      | Mid-session, when **either** of two thresholds is hit since the last summary: |
|                   | • messages-since-last-summary ≥ `HIVEMIND_SUMMARY_EVERY_N_MSGS` (default 50)  |
|                   | • elapsed time ≥ `HIVEMIND_SUMMARY_EVERY_HOURS` (default 2)                   |

The first message after a long pause therefore triggers a fresh
summary; long sessions naturally checkpoint every ~50 messages.

A per-session JSON sidecar at
`~/.claude/hooks/summary-state/<sessionId>.json` tracks
`{lastSummaryAt, lastSummaryCount, totalCount}`. The dir is shared
across all agents (session ids are UUIDs so no collisions). It is
**never deleted**, so resuming a session via `--resume` / `--continue`
picks up where it left off.

### How a summary is generated

1. The wiki worker queries the `sessions` table for every event tied to
   that session.
2. It builds a structured prompt asking the host agent's CLI to extract
   entities, decisions, files modified, open questions, etc.
3. It shells out to that agent's CLI (`claude -p`, `codex exec`,
   `pi --print`, …) with the prompt — never a separate API key, the
   agent's existing credentials are used.
4. The generated markdown is uploaded to the `memory` table at
   `/summaries/<user>/<sessionId>.md`. The shared embedding daemon
   produces the 768-dim `summary_embedding` so the summary is recallable
   via semantic search.

A lock file at `~/.claude/hooks/summary-state/<sessionId>.lock`
prevents two workers from running concurrently for the same session.

### Configuration

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

For pi specifically, the wiki worker is bundled separately at
`~/.pi/agent/hivemind/wiki-worker.js` (deposited by `hivemind pi install`).
The other agents ship the wiki worker inside their per-agent plugin
bundle.

## Skills (skilify)

This is where auto-learning becomes concrete. Hivemind **codifies recurring
patterns from your team's recent sessions into reusable skills** that
propagate to every agent on your team — automatically. Same architecture
as the wiki worker: an async background process that fires on Stop /
SessionEnd, mines recent sessions in scope, asks Haiku whether the
activity contains something worth keeping, and writes a `SKILL.md` if so.

### When the skilify worker fires

| Trigger          | When it fires                                                                  |
|------------------|--------------------------------------------------------------------------------|
| **Stop counter** | Mid-session, after every `HIVEMIND_SKILIFY_EVERY_N_TURNS` (default 20) turns. |
| **SessionEnd**   | Always at end-of-session, regardless of counter — catches tail-of-session knowledge. |

Per-project counter state lives at
`~/.deeplake/state/skilify/<project-key>.json`. Project key is the sha1
of `git config remote.origin.url` (with the absolute path as fallback for
non-git dirs).

### How a skill is generated

1. The worker pulls the **last 10 sessions in scope** from the `sessions`
   Deeplake table — strictly newer than the watermark in the state file.
2. It strips each session to **prompt + assistant text only** (tool calls
   and thinking blocks are dropped — they're noise for skill mining).
3. It builds a gate prompt: existing project skill bodies + the 10
   stripped exchanges + decision rules.
4. It runs `claude -p haiku --permission-mode bypassPermissions` with the
   prompt. The model returns a JSON verdict:
   - `KEEP <name> <body>` — write a new skill.
   - `MERGE <existing-name> <merged-body>` — update an existing skill, bump version.
   - `SKIP <reason>` — pattern is one-off / generic / already covered.
5. On KEEP/MERGE the skill is written to `<project>/.claude/skills/<name>/SKILL.md`
   (or `~/.claude/skills/...` if you've set `install` to `global`), with
   provenance frontmatter (`source_sessions`, `version`, `created_by_agent`,
   timestamps).
6. A row is also inserted into the `skills` Deeplake table for org-wide
   provenance (append-only — never UPDATE, sidesteps the
   UPDATE-coalescing quirk).

### `/skilify` — managing scope, team, install location

The `/skilify` slash command (Claude Code, Codex) and the `hivemind
skilify` CLI control mining behaviour.

```bash
hivemind skilify                            # show current scope, team, install, per-project state
hivemind skilify scope <me|team|org>        # who counts as "in scope" for mining
hivemind skilify install <project|global>   # where new skills are written
hivemind skilify promote <skill-name>       # move a project skill to ~/.claude/skills/
hivemind skilify team add <username>        # add to the team list (used when scope=team)
hivemind skilify team remove <username>     # remove from team
hivemind skilify team list                  # list current team members
```

The team list flows into the worker's session-fetch SQL: `scope=me`
filters by your own username, `scope=team` filters by `author IN
(<team>)`, `scope=org` applies no author filter.

Config persists at `~/.deeplake/state/skilify/config.json` (one global
file shared across projects).

### `pull` / `unpull` — sharing skills across the org

Once a teammate's skills are mined into the Deeplake `skills` table, you
can install them locally with `pull`. Layout written to disk:

```text
<root>/<name>--<author>/SKILL.md      ← pulled skills (e.g. deploy--alice/)
<root>/<name>/SKILL.md                ← your locally-mined skills (flat, no suffix)
```

The `--<author>` suffix keeps cross-author entries with the same name
disjoint and lets Claude Code's single-depth skill loader find pulled
skills without any symlink trickery. `<root>` is `~/.claude/skills` for
`--to global` and `<cwd>/.claude/skills` for `--to project`.

```bash
hivemind skilify pull                                # all authors, install globally
hivemind skilify pull --user alice@example.com       # only this author
hivemind skilify pull --users a@x.com,b@y.com        # multiple authors (CSV)
hivemind skilify pull --all-users                    # explicit "no author filter" (default)
hivemind skilify pull --to project                   # install under <cwd>/.claude/skills
hivemind skilify pull --dry-run                      # preview, no disk writes
hivemind skilify pull --force                        # overwrite even when local version >= remote
hivemind skilify pull <skill-name>                   # pull only that skill (combinable with --user)
```

Every successful pull records an entry in
`~/.deeplake/state/skilify/pulled.json`. That manifest is the source of
truth for `unpull` — anything not in the manifest is **never** touched
by default, even if its directory follows the `<name>--<author>` shape
(this protects user-authored variant skills like `deploy--blue-green`).

```bash
hivemind skilify unpull                              # remove every pulled entry under the install scope
hivemind skilify unpull --user alice@example.com     # remove only this author's pulls
hivemind skilify unpull --users a@x.com,b@y.com      # multiple authors
hivemind skilify unpull --not-mine                   # remove all pulls except your own
hivemind skilify unpull --dry-run                    # preview, no disk writes
hivemind skilify unpull --to project                 # operate on <cwd>/.claude/skills instead of global
hivemind skilify unpull --all                        # ALSO remove flat-layout (locally-mined) skills — destructive
hivemind skilify unpull --legacy-cleanup             # ALSO remove pre-`--author`-layout `<projectkey>/` dirs from older skilify versions
```

Drift handling: if a manifest entry's directory was deleted out-of-band
(e.g. `rm -rf` by hand), the next `unpull` reports it as `manifest-orphan`
and prunes the entry from the manifest without errors.

Cross-project caveat: same `(name, author)` from two different projects
collides on disk under the new flat layout — the more recently pulled
row wins, and the prior `SKILL.md` is preserved as `SKILL.md.bak`. The
underlying row stays in the Deeplake `skills` table, so re-pulling from
the other project recovers it.

### Configuration

| Env var                              | Default | Effect                                                  |
|--------------------------------------|---------|---------------------------------------------------------|
| `HIVEMIND_SKILIFY_EVERY_N_TURNS`     | `20`    | Stop-counter threshold for mid-session worker fires     |
| `HIVEMIND_SKILLS_TABLE`              | `skills`| Deeplake table name for org-wide provenance             |
| `HIVEMIND_SKILIFY_WORKER=1`          | unset   | Recursion guard (set automatically inside the worker)   |
| `HIVEMIND_CURSOR_MODEL`              | `auto`  | (cursor only) model passed to the cursor-agent gate call |
| `HIVEMIND_HERMES_PROVIDER`           | `openrouter` | (hermes only) provider passed to the hermes gate call |
| `HIVEMIND_HERMES_MODEL`              | `anthropic/claude-haiku-4-5` | (hermes only) model passed to hermes |

### Per-agent gate CLI

The skilify worker calls each agent's own headless CLI for the gate
prompt — so a user who only has codex / cursor / hermes installed
never needs `claude` in their PATH:

| Agent       | Gate command                                                                          |
|-------------|----------------------------------------------------------------------------------------|
| claude_code | `claude -p <prompt> --no-session-persistence --model haiku --permission-mode bypassPermissions` |
| codex       | `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`                       |
| cursor      | `cursor-agent --print --model <HIVEMIND_CURSOR_MODEL> --force --output-format text <prompt>` |
| hermes      | `hermes -z <prompt> --provider <HIVEMIND_HERMES_PROVIDER> -m <HIVEMIND_HERMES_MODEL> --yolo --ignore-user-config` |

For hermes via OpenRouter (the default), set `OPENROUTER_API_KEY` in
the environment; the worker inherits the parent process env. Other
providers (anthropic, openai, etc.) need their respective API keys.

### Logs

Worker activity logs to `~/.claude/hooks/skilify.log`. Each line shows
which session pool was mined, what the gate decided, and whether a file
was written.

## Architecture

### Integration model per agent

| Agent             | Mechanism                          | Hooks/tools wired                                                                       |
|-------------------|------------------------------------|-----------------------------------------------------------------------------------------|
| **Claude Code**   | Marketplace plugin                 | `SessionStart` · `UserPromptSubmit` · `PreToolUse` · `PostToolUse` · `Stop` · `SubagentStop` · `SessionEnd` |
| **Codex**         | `~/.codex/hooks.json`              | `SessionStart` · `UserPromptSubmit` · `PreToolUse(Bash)` · `PostToolUse` · `Stop`        |
| **OpenClaw**      | Native extension at `~/.openclaw/extensions/hivemind/` | `agent_end` capture · `before_agent_start` recall · contracted tools (`hivemind_search`/`read`/`index`) |
| **Cursor (1.7+)** | `~/.cursor/hooks.json`             | `sessionStart` · `beforeSubmitPrompt` · `postToolUse` · `afterAgentResponse` · `stop` · `sessionEnd` |
| **Hermes**        | Skill at `~/.hermes/skills/hivemind-memory/` | recall via grep on `~/.deeplake/memory/`                                                |
| **pi**            | `~/.pi/agent/AGENTS.md` + skill    | recall via grep on `~/.deeplake/memory/`                                                |

### Monorepo structure

```
hivemind/
├── src/                    ← shared core (API client, auth, config, SQL utils)
│   ├── hooks/              ← Claude Code hooks
│   ├── hooks/codex/        ← Codex hooks
│   ├── hooks/cursor/       ← Cursor hooks
│   ├── hooks/hermes/       ← Hermes shell hooks
│   ├── hooks/pi/           ← pi wiki-worker (extension lives in pi/extension-source/)
│   ├── embeddings/         ← nomic embed-daemon + protocol + SQL helpers
│   ├── mcp/                ← MCP server (used by Hermes; available to any future MCP-aware client)
│   ├── commands/           ← auth, auth-creds, auth-login, session-prune
│   └── cli/                ← unified `hivemind install` CLI + per-agent installers
├── claude-code/            ← Claude Code plugin source (marketplace-distributed)
├── codex/                  ← Codex plugin build output (npm-distributed)
├── cursor/                 ← Cursor plugin build output (npm-distributed)
├── hermes/                 ← Hermes plugin build output (npm-distributed)
├── mcp/                    ← MCP server build output (shared by Hermes + future MCP clients)
├── openclaw/               ← OpenClaw plugin source + build output (ClawHub-distributed)
├── pi/                     ← pi extension source (ships raw .ts; pi compiles at load)
└── bundle/                 ← unified `hivemind` CLI build output
```

## Roadmap

- **Trajectory export for fine-tuning.** Because traces are stored in Deeplake's tensor format, they're export-ready as PyTorch datasets. Teams running their own open-source models can fine-tune on their org's accumulated trajectories. A handful of advanced customers are already doing this against the trajectories their Claude Code and Codex agents generated.
- **Dense vector retrieval.** Currently using BM25 + grep fallback. Dense retrieval over GPU-accelerated vector search is in active development.
- **Skill versioning and review.** Pre-release human review for codified skills before they propagate org-wide, for teams that want a curation step.
- **More agents.** If your team uses an agent that isn't on the supported-assistants list above, open an issue.

## Security

- SQL values escaped with `sqlStr()`, `sqlLike()`, `sqlIdent()`
- ~70 allowlisted builtins run in the virtual FS; unrecognized commands are denied
- Credentials stored with mode `0600`, config dir with mode `0700`
- Device flow login: no tokens in environment or code
- `HIVEMIND_CAPTURE=false` fully disables data collection

## Development

```bash
git clone https://github.com/activeloopai/hivemind.git
cd hivemind
npm install
npm run build     # tsc + esbuild → claude-code/bundle/ + codex/bundle/ + cursor/bundle/ + openclaw/dist/ + mcp/bundle/ + bundle/cli.js
npm test          # vitest
```

Test locally with Claude Code:

```bash
claude --plugin-dir claude-code
```

Interactive shell against Deeplake:

```bash
npm run shell
```

## License

Apache License 2.0 — © Activeloop, Inc. See [LICENSE](LICENSE) for details.

