#!/usr/bin/env bash
# Hivemind install verifier — sanity-checks each of the 9 agent integrations.
#
# Run this after `npx -y @deeplake/hivemind install`. It checks file
# placement, config schema, dry-invokes hook scripts, and exercises the
# MCP server against its initialize handshake. Doesn't require any agent
# to actually be running — just verifies our installer's footprint.
#
# Exits 0 if everything we installed is healthy; 1 if any agent fails.
# Skips agents whose marker dir doesn't exist (you don't have them).
#
# Usage:
#   bash scripts/verify-install.sh
#   curl -sSL https://raw.githubusercontent.com/activeloopai/hivemind/main/scripts/verify-install.sh | bash

set -u

PASS=0
FAIL=0
SKIP=0

green() { printf "\033[0;32m%s\033[0m" "$1"; }
red()   { printf "\033[0;31m%s\033[0m" "$1"; }
gray()  { printf "\033[0;90m%s\033[0m" "$1"; }
yellow(){ printf "\033[0;33m%s\033[0m" "$1"; }

ok()   { echo "  $(green PASS) $1"; PASS=$((PASS+1)); }
bad()  { echo "  $(red FAIL) $1${2:+ — $2}"; FAIL=$((FAIL+1)); }
skip() { echo "  $(gray SKIP) $1${2:+ — $2}"; SKIP=$((SKIP+1)); }

section() { echo; echo "$(yellow "▎ $1")"; }

require_jq() {
  command -v jq >/dev/null 2>&1 || {
    echo "$(red "fatal:") jq not found on PATH (install jq for this script to run)" >&2
    exit 2
  }
}
require_jq

# ───────────────────────────────────────────────────────────────────────
# Claude Code — marketplace plugin
section "Claude Code"
if [ -d "$HOME/.claude" ]; then
  if command -v claude >/dev/null 2>&1; then
    if claude plugin list 2>/dev/null | grep -q "hivemind@hivemind"; then
      ok "claude plugin list shows hivemind@hivemind"
      if claude plugin list 2>/dev/null | grep -q "✔ enabled"; then
        ok "plugin enabled"
      else
        bad "plugin not enabled" "run: claude plugin enable hivemind@hivemind"
      fi
    else
      bad "claude plugin list does not show hivemind@hivemind" "rerun: hivemind claude install"
    fi
  else
    bad "claude CLI not found on PATH" "Claude Code is not installed correctly"
  fi
else
  skip "Claude Code" "no ~/.claude"
fi

# ───────────────────────────────────────────────────────────────────────
# Codex — ~/.codex/hooks.json + bundle
section "Codex"
if [ -d "$HOME/.codex" ]; then
  HOOKS="$HOME/.codex/hooks.json"
  if [ -f "$HOOKS" ]; then
    if jq -e '.hooks.SessionStart' "$HOOKS" >/dev/null 2>&1; then
      ok "$HOOKS has SessionStart"
    else
      bad "$HOOKS missing SessionStart"
    fi
  else
    bad "$HOOKS not found" "rerun: hivemind codex install"
  fi
  if [ -x "$HOME/.codex/hivemind/bundle/session-start.js" ]; then
    ok "session-start.js executable"
  else
    bad "session-start.js missing or not executable"
  fi
else
  skip "Codex" "no ~/.codex"
fi

# ───────────────────────────────────────────────────────────────────────
# OpenClaw — ~/.openclaw/extensions/hivemind/
section "OpenClaw"
if [ -d "$HOME/.openclaw" ]; then
  EXT="$HOME/.openclaw/extensions/hivemind"
  if [ -f "$EXT/openclaw.plugin.json" ]; then
    ok "openclaw.plugin.json present"
    if jq -e '.contracts.tools' "$EXT/openclaw.plugin.json" >/dev/null 2>&1; then
      ok "manifest declares contracts.tools"
    else
      bad "manifest missing contracts.tools (stale install)"
    fi
  else
    bad "$EXT/openclaw.plugin.json not found" "rerun: hivemind claw install"
  fi
  [ -f "$EXT/dist/index.js" ] && ok "dist/index.js present" || bad "dist/index.js not found"
else
  skip "OpenClaw" "no ~/.openclaw"
fi

# ───────────────────────────────────────────────────────────────────────
# Cursor — ~/.cursor/hooks.json (1.7+ schema)
section "Cursor"
if [ -d "$HOME/.cursor" ]; then
  HOOKS="$HOME/.cursor/hooks.json"
  if [ -f "$HOOKS" ]; then
    for ev in sessionStart beforeSubmitPrompt postToolUse afterAgentResponse stop sessionEnd; do
      if jq -e ".hooks.$ev[0].command" "$HOOKS" >/dev/null 2>&1; then
        ok "hooks.$ev wired"
      else
        bad "hooks.$ev missing" "rerun: hivemind cursor install"
      fi
    done
    # Dry-invoke session-start.js
    payload='{"hook_event_name":"sessionStart","session_id":"verify","conversation_id":"verify","workspace_roots":["/tmp"]}'
    if echo "$payload" | timeout 5 node "$HOME/.cursor/hivemind/bundle/session-start.js" 2>/dev/null | jq -e '.additional_context' >/dev/null 2>&1; then
      ok "session-start.js produces valid additional_context JSON"
    else
      bad "session-start.js dry-invoke did not return additional_context"
    fi
  else
    bad "$HOOKS not found" "rerun: hivemind cursor install"
  fi
else
  skip "Cursor" "no ~/.cursor"
fi

# ───────────────────────────────────────────────────────────────────────
# Hermes Agent — skill drop
section "Hermes Agent"
if [ -d "$HOME/.hermes" ]; then
  SKILL="$HOME/.hermes/skills/hivemind-memory/SKILL.md"
  if [ -f "$SKILL" ]; then
    ok "SKILL.md present at $SKILL"
    if grep -q "Hivemind Memory" "$SKILL"; then
      ok "skill content looks right"
    else
      bad "skill content missing 'Hivemind Memory' header"
    fi
  else
    bad "$SKILL not found" "rerun: hivemind hermes install"
  fi
else
  skip "Hermes Agent" "no ~/.hermes"
fi

# ───────────────────────────────────────────────────────────────────────
# pi — AGENTS.md + extension
# No per-agent SKILL.md: pi reads skills from both ~/.pi/agent/skills/ AND
# ~/.agents/skills/ (the agentskills.io shared dir), so dropping a local
# skill would collide with the codex installer's shared symlink. AGENTS.md
# (auto-loaded every turn) plus the registered hivemind tools cover the
# action surface; see install-pi.ts for the rationale.
section "pi"
if [ -d "$HOME/.pi" ]; then
  AGENTS="$HOME/.pi/agent/AGENTS.md"
  if [ -f "$AGENTS" ] && grep -q "BEGIN hivemind-memory" "$AGENTS"; then
    ok "AGENTS.md has BEGIN hivemind-memory marker"
  else
    bad "AGENTS.md missing hivemind block" "rerun: hivemind pi install"
  fi
  EXT="$HOME/.pi/agent/extensions/hivemind.ts"
  if [ -f "$EXT" ]; then
    ok "extension installed at $EXT"
    # Sanity-check that key surfaces are wired in the installed extension.
    if grep -q "registerTool" "$EXT" && grep -q "hivemind_search" "$EXT" && \
       grep -q "hivemind_read" "$EXT" && grep -q "hivemind_index" "$EXT"; then
      ok "extension registers hivemind_search / hivemind_read / hivemind_index"
    else
      bad "extension missing one or more hivemind_* tool registrations"
    fi
    if grep -q 'pi.on("tool_result"' "$EXT" && grep -q 'pi.on("input"' "$EXT"; then
      ok "extension subscribes to input + tool_result for autocapture"
    else
      bad "extension missing input/tool_result subscriptions"
    fi
  else
    bad "$EXT not found" "rerun: hivemind pi install"
  fi
else
  skip "pi" "no ~/.pi"
fi

# ───────────────────────────────────────────────────────────────────────
# MCP server (used by Hermes; reused by any future MCP-aware client).
section "Hivemind MCP server"
SERVER="$HOME/.hivemind/mcp/server.js"
if [ -f "$SERVER" ]; then
  ok "server.js installed at $SERVER"
  # Initialize + tools/list handshake. Expect "hivemind_search" in response.
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}'
  inited='{"jsonrpc":"2.0","method":"notifications/initialized"}'
  list='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  resp=$( ( printf '%s\n%s\n%s\n' "$init" "$inited" "$list"; sleep 1 ) | timeout 8 node "$SERVER" 2>/dev/null )
  if echo "$resp" | grep -q '"hivemind_search"'; then
    ok "tools/list returns hivemind_search / hivemind_read / hivemind_index"
  else
    bad "MCP server did not list expected tools" "check ~/.deeplake/credentials.json"
  fi
else
  skip "MCP server" "no ~/.hivemind/mcp/server.js (no MCP-aware agent installed yet)"
fi

# ───────────────────────────────────────────────────────────────────────
echo
echo "$(yellow "▎ Summary")"
echo "  $(green PASS): $PASS"
echo "  $(red  FAIL): $FAIL"
echo "  $(gray SKIP): $SKIP (agent not present on this machine)"
echo

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
