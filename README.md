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
  <a href="https://www.npmjs.com/package/@deeplake/hivemind"><img src="https://img.shields.io/npm/v/@deeplake/hivemind?color=blue&label=npm" alt="npm"></a>
  <a href="https://github.com/activeloopai/hivemind/stargazers"><img src="https://img.shields.io/github/stars/activeloopai/hivemind?style=social" alt="GitHub stars"></a>
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

**Beyond memory.** Hivemind captures every coding-agent interaction in your org as a structured trace, codifies repeated patterns into reusable skills, and propagates those skills to every agent on your team.

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

The installer detects every supported assistant on your machine (table below), wires up the hooks, and opens a browser once for login. Restart them after install.

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

**Capture → Codify → Propagate → Compound.** Every coding-agent interaction (prompt, tool call, response) is captured as a structured trace in Deeplake. A background worker mines traces for repeated patterns and codifies them into `SKILL.md` files, scoped to your workspace. Codified skills propagate into every Hivemind-connected agent's context at inference time. The agent your junior engineer used this morning is sharper because of what your senior engineer's agent figured out last week.

## Features

### 🔍 Natural search

Just ask your agent naturally:

```
"What was Emanuele working on?"
"Search traces for authentication bugs we've solved"
"What did we decide about the API design?"
"Show me skills my team has codified for handling migrations"
```

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

## Semantic search (optional)

Hivemind ships with a local embedding daemon (nomic-embed-text-v1.5) for hybrid semantic + lexical search over `~/.deeplake/memory/`. **Off by default** because the dependency footprint is ~600 MB. Enable with `hivemind embeddings install` (or `hivemind install --with-embeddings`). Without it, search degrades silently to BM25/lexical-only.

Full guide: **[docs/EMBEDDINGS.md](docs/EMBEDDINGS.md)**.

## Summaries

After each session, a background worker generates an AI-written wiki summary and stores it in the `memory` table alongside its 768-dim embedding. Long sessions checkpoint mid-session every 50 messages or 2 hours (configurable). The wiki worker shells out to the host agent's own CLI (`claude -p`, `codex exec`, `pi --print`, …) — no separate API key. Browse summaries at `~/.deeplake/memory/summaries/`.

Triggers, generation flow, and env-var reference: **[docs/SUMMARIES.md](docs/SUMMARIES.md)**.

## Skills (skillify)

Hivemind **codifies recurring patterns from your team's recent sessions into reusable skills** that propagate to every agent on your team — automatically. An async background worker fires on Stop / SessionEnd, mines recent sessions in scope, asks Haiku whether the activity contains something worth keeping, and writes a `SKILL.md` to `<project>/.claude/skills/<name>/`.

```bash
hivemind skillify                            # show current scope, team, install, per-project state
hivemind skillify scope <me|team>            # who counts as "in scope" for mining
hivemind skillify pull                       # install teammates' skills locally
hivemind skillify unpull                     # remove pulled skills
```

Triggers, generation flow, full `pull` / `unpull` semantics, gate-CLI table per agent, env vars, logs: **[docs/SKILLIFY.md](docs/SKILLIFY.md)**.

## Architecture

Per-agent integration mechanisms (marketplace plugin, hooks, skills, native extension) and monorepo structure: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Roadmap

- **Trajectory export for fine-tuning.** Because traces are stored in Deeplake's tensor format, they're export-ready as PyTorch datasets. Teams running their own open-source models can fine-tune on their org's accumulated trajectories. A handful of advanced customers are already doing this against the trajectories their Claude Code and Codex agents generated.
- **GPU-accelerated dense retrieval at scale.** Local CPU embeddings already ship via the optional nomic-embed daemon (see [Semantic search](#semantic-search-optional)). Next: GPU-accelerated vector search over the full trace store, on by default.
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

