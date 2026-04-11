#!/bin/bash
# Hivemind — Codex CLI plugin installer
# Usage: Run from the cloned repo, or pipe from GitHub:
#   git clone https://github.com/activeloopai/hivemind.git ~/.codex/hivemind && ~/.codex/hivemind/codex/install.sh

set -e

# Resolve the plugin directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$SCRIPT_DIR"

# If installed at ~/.codex/hivemind/codex/, the root is one level up
if [ "$(basename "$SCRIPT_DIR")" = "codex" ]; then
  PLUGIN_ROOT="$SCRIPT_DIR"
fi

echo "Installing Hivemind for Codex CLI..."
echo "  Plugin: $PLUGIN_ROOT"

# 1. Enable hooks feature
codex features enable codex_hooks 2>/dev/null || true

# 2. Generate hooks.json with absolute paths
cat > "$HOME/.codex/hooks.json" << EOF
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"$PLUGIN_ROOT/bundle/session-start.js\"", "timeout": 120 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"$PLUGIN_ROOT/bundle/capture.js\"", "timeout": 10 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"$PLUGIN_ROOT/bundle/pre-tool-use.js\"", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"$PLUGIN_ROOT/bundle/capture.js\"", "timeout": 15 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"$PLUGIN_ROOT/bundle/stop.js\"", "timeout": 30 }] }
    ]
  }
}
EOF

# 3. Symlink skills for native discovery
mkdir -p "$HOME/.agents/skills"
ln -sf "$PLUGIN_ROOT/skills/deeplake-memory" "$HOME/.agents/skills/hivemind-memory"

# 4. Run login if no credentials exist
if [ ! -f "$HOME/.deeplake/credentials.json" ]; then
  echo ""
  echo "No Deeplake credentials found. Starting login..."
  node "$PLUGIN_ROOT/bundle/commands/auth-login.js" login
fi

echo ""
echo "Hivemind installed for Codex CLI."
echo ""
echo "  Hooks:  ~/.codex/hooks.json"
echo "  Skills: ~/.agents/skills/hivemind-memory"
echo ""
echo "Restart Codex to activate. To update later:"
echo "  cd ~/.codex/hivemind && git pull"
