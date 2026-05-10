# Architecture

## Integration model per agent

| Agent             | Mechanism                          | Hooks/tools wired                                                                       |
|-------------------|------------------------------------|-----------------------------------------------------------------------------------------|
| **Claude Code**   | Marketplace plugin                 | `SessionStart` · `UserPromptSubmit` · `PreToolUse` · `PostToolUse` · `Stop` · `SubagentStop` · `SessionEnd` |
| **Codex**         | `~/.codex/hooks.json`              | `SessionStart` · `UserPromptSubmit` · `PreToolUse(Bash)` · `PostToolUse` · `Stop`        |
| **OpenClaw**      | Native extension at `~/.openclaw/extensions/hivemind/` | `agent_end` capture · `before_agent_start` recall · contracted tools (`hivemind_search`/`read`/`index`) |
| **Cursor (1.7+)** | `~/.cursor/hooks.json`             | `sessionStart` · `beforeSubmitPrompt` · `postToolUse` · `afterAgentResponse` · `stop` · `sessionEnd` |
| **Hermes**        | Skill at `~/.hermes/skills/hivemind-memory/` | recall via grep on `~/.deeplake/memory/`                                                |
| **pi**            | `~/.pi/agent/AGENTS.md` + skill    | recall via grep on `~/.deeplake/memory/`                                                |

## Monorepo structure

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
