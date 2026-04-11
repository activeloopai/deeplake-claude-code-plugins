# Installing Hivemind for Codex CLI

Persistent shared memory for Codex agents. Clone, install, and restart.

## Prerequisites

- Git
- Node.js >= 22
- [Codex CLI](https://github.com/openai/codex) installed

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/activeloopai/hivemind.git ~/.codex/hivemind
   ```

2. **Run the install script:**
   ```bash
   ~/.codex/hivemind/codex/install.sh
   ```

   This will:
   - Enable the `codex_hooks` feature flag
   - Generate `~/.codex/hooks.json` with the correct paths
   - Symlink skills into `~/.agents/skills/hivemind-memory`
   - Prompt you to log in if no credentials are found

3. **Restart Codex** (quit and relaunch the CLI) to activate the hooks.

## Verify

```bash
# Check hooks are configured
cat ~/.codex/hooks.json | head -3

# Check skill is linked
ls -la ~/.agents/skills/hivemind-memory

# Check bundles exist
ls ~/.codex/hivemind/codex/bundle/
```

You should see 7 bundle files and a symlink pointing to your hivemind skills directory.

## Updating

```bash
cd ~/.codex/hivemind && git pull
```

Hooks and skills update instantly — restart Codex to apply.

## Uninstalling

```bash
rm -f ~/.codex/hooks.json ~/.agents/skills/hivemind-memory
rm -rf ~/.codex/hivemind
```
