# Installing Hivemind for Codex CLI

The fastest path installs hivemind into every AI coding assistant on your machine (Claude Code, Codex, OpenClaw) with one command:

```bash
npx @activeloop/hivemind@latest install
```

Or install for Codex only:

```bash
npx @activeloop/hivemind@latest codex install
```

The installer:

- Enables the `codex_hooks` feature flag
- Writes `~/.codex/hooks.json` with hivemind entries
- Copies the plugin bundle to `~/.codex/hivemind/`
- Symlinks the skill into `~/.agents/skills/hivemind-memory`
- Opens a browser once for login (shared across all assistants)

Restart Codex (quit and relaunch the CLI) to activate.

## Prerequisites

- Node.js >= 22
- [Codex CLI](https://github.com/openai/codex) installed

## Verify

```bash
cat ~/.codex/hooks.json | head -3
ls -la ~/.agents/skills/hivemind-memory
ls ~/.codex/hivemind/bundle/
```

## Updating

```bash
npx @activeloop/hivemind@latest codex install
```

Re-running is idempotent — hooks and skills get replaced in place.

## Uninstalling

```bash
npx @activeloop/hivemind@latest codex uninstall
```

Removes `~/.codex/hooks.json` and the skill symlink. Plugin files remain at `~/.codex/hivemind/` so a reinstall is cheap; delete the directory manually if you want a full cleanup.
