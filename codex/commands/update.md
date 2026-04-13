---
description: Update the Hivemind plugin to the latest version
allowed-tools: Bash
---

Find the installed plugin cache and update it from GitHub:

```bash
# Find the installed hivemind plugin cache directory
PLUGIN_DIR=$(find ~/.codex/plugins/cache -maxdepth 3 -name "hivemind" -type d 2>/dev/null | head -1)
if [ -z "$PLUGIN_DIR" ]; then
  echo "Error: Hivemind plugin not found in ~/.codex/plugins/cache/. Is it installed?"
  exit 1
fi
# Use the most recent version directory
VERSION_DIR=$(ls -1d "$PLUGIN_DIR"/*/ 2>/dev/null | tail -1)
if [ -z "$VERSION_DIR" ]; then
  VERSION_DIR="$PLUGIN_DIR/local/"
fi
echo "Updating plugin at: $VERSION_DIR"
# Download latest release from GitHub
TMPDIR=$(mktemp -d)
git clone --depth 1 https://github.com/activeloopai/hivemind.git "$TMPDIR/hivemind" 2>&1
if [ $? -ne 0 ]; then
  echo "Error: Failed to clone from GitHub. Check your internet connection."
  rm -rf "$TMPDIR"
  exit 1
fi
# Copy codex plugin files over the cached version
cp -r "$TMPDIR/hivemind/codex/"* "$VERSION_DIR/"
NEW_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('$VERSION_DIR/.codex-plugin/plugin.json','utf-8')).version" 2>/dev/null || echo "unknown")
rm -rf "$TMPDIR"
echo "Updated to v$NEW_VERSION. Restart Codex to apply."
```

After running, tell the user to restart Codex to pick up the new version.
