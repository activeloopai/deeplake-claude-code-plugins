#!/bin/bash
# Hivemind — Codex CLI plugin installer.
# This script now delegates to the unified `hivemind` CLI, which handles
# Claude Code, Codex, and OpenClaw from a single entrypoint.
#
# Equivalent to: npx @activeloop/hivemind@latest codex install

set -e
exec npx -y @activeloop/hivemind@latest codex install
