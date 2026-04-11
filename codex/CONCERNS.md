# Codex Plugin — Concerns & Differences from Claude Code

## Architecture Summary

The Codex plugin mirrors the Claude Code plugin's functionality: session capture, memory filesystem interception, context injection, and session summary generation. It reuses the same shared modules (`config.ts`, `deeplake-api.ts`, `utils/`, `shell/`, `commands/`) and only differs in the hook entry points (`src/hooks/codex/`) that handle the platform-specific JSON wire format.

---

## What's Different Between Claude Code and Codex

### 1. PreToolUse only intercepts Bash (CRITICAL)

**Claude Code**: PreToolUse fires for Read, Write, Edit, Glob, Grep, and Bash. ANY tool call targeting `~/.deeplake/memory/` is intercepted — structured file reads, edits, searches, everything.

**Codex**: PreToolUse only fires for the Bash tool. If Codex adds structured file tools (like a native Read or Write), those calls to `~/.deeplake/memory/` would **bypass our interception entirely** and hit the real filesystem (which has no data — it's a virtual path backed by the cloud API).

**Mitigation**: In practice Codex's primary tool IS Bash — it runs `cat`, `ls`, `grep`, `echo >` etc. All of those are intercepted. But if OpenAI adds new tools, we need to update the matcher.

**Future option**: Bundle an MCP server exposing `deeplake_read`/`deeplake_write`/`deeplake_search` tools. This bypasses the Bash-only limitation entirely.

### 2. No SessionEnd event — Stop does double duty

**Claude Code**: Has separate `Stop` (turn ends) and `SessionEnd` (session closes) hooks. SessionEnd spawns the wiki summary worker.

**Codex**: Only has `Stop`. Our `stop.js` combines both: captures the stop event AND spawns the wiki worker. This means:
- The wiki worker may be spawned multiple times per session (once per Stop)
- The worker handles this gracefully (checks existing summaries, uses JSONL offset tracking)
- But it's more wasteful — extra API calls and multiple summary rewrites

### 3. No SubagentStop event

**Claude Code**: Has `SubagentStop` for capturing output when subagents finish.

**Codex**: No equivalent. Subagent output won't be captured separately — lower fidelity session capture for multi-agent workflows.

### 4. No async hook flag

**Claude Code**: Hooks can be marked `"async": true` to run without blocking. We use this for PostToolUse capture.

**Codex**: All matching hooks run concurrently but there's no async flag. PostToolUse capture blocks until complete. The 15-second timeout should be sufficient, but high-latency API calls could occasionally cause timeouts.

### 5. Plugin path resolution (`$CODEX_PLUGIN_ROOT`) — UNVERIFIED

**Claude Code**: Hooks reference `${CLAUDE_PLUGIN_ROOT}` which resolves to the installed plugin directory.

**Codex**: We use `$CODEX_PLUGIN_ROOT` but this is **unconfirmed**. If it doesn't resolve, hooks won't find the bundled JS files and nothing will work.

**Action needed**: Test with an actual Codex installation.

### 6. No `last_assistant_message` in Stop

**Claude Code**: Stop includes `last_assistant_message` — the final assistant text.

**Codex**: Stop provides only session metadata (session_id, cwd, model). Stop events are captured with empty content. Session summaries may miss the final response.

### 7. Output format differences

| Hook | Claude Code | Codex |
|------|------------|-------|
| SessionStart | `{ hookSpecificOutput: { hookEventName, additionalContext } }` | `{ additionalContext }` (flat, no wrapper) |
| PreToolUse allow | `hookSpecificOutput.updatedInput { command, description }` | `hookSpecificOutput.updatedInput { command }` (no description) |
| PreToolUse deny | `hookSpecificOutput { permissionDecision, permissionDecisionReason }` | Same format |

**Note**: The SessionStart flat format needs verification — if Codex actually expects `hookSpecificOutput` wrapper, context injection will silently fail.

### 8. No auto-update

**Claude Code**: Session-start can auto-update the plugin via `claude plugin update`.

**Codex**: No equivalent command. Version check runs and notifies via stderr, but cannot auto-update.

### 9. Wiki worker binary compatibility

The wiki worker uses `claude -p` with flags like `--no-session-persistence`, `--model haiku`, `--permission-mode bypassPermissions`. The `findCodexBin()` tries `codex` first, then falls back to `claude`. If `codex` is found but doesn't support these flags, wiki generation fails silently.

### 10. Plugin hooks discovery — UNVERIFIED

The `plugin.json` manifest does not reference `hooks/hooks.json`. Codex discovers hooks next to config layers (`~/.codex/hooks.json` or `<repo>/.codex/hooks.json`), but it's unclear if plugin-bundled hooks are auto-discovered from the `.codex-plugin/` directory.

### 11. Grep command parsing is best-effort

Claude Code receives structured `{ pattern, path }` fields for Grep. Codex only sees raw Bash strings. Our regex parses common patterns (`grep -ri 'keyword' /path`), but edge cases like multiple `-e` patterns, `--` argument terminators, or complex pipelines may not be parsed correctly and will fall through to the virtual shell (slower but still functional).

### 12. Context instructions differ

Claude Code context says `Grep pattern="keyword" path="~/.deeplake/memory"` and references slash commands like `/hivemind:login`.

Codex context says `grep -r "keyword" ~/.deeplake/memory/` and references `node "AUTH_CMD" login` directly, since Codex doesn't have Claude Code's slash command or Grep tool.

---

## What Works Identically

- **Session capture**: UserPromptSubmit and PostToolUse capture — same JSONL format, same sessions table
- **Memory reads/writes via Bash**: `cat`, `ls`, `echo >`, `grep` all intercepted and routed through the virtual FS
- **SQL direct path**: Fast-path SQL queries for `cat` and `grep` bypass the shell for better performance
- **Credentials and config**: Same `~/.deeplake/credentials.json`, same environment variables
- **Wiki summary generation**: Same `wiki-worker.js`, same prompt template, same output format
- **Auth commands**: Same `auth-login.js` for SSO, org/workspace management
- **Version check**: Both read from their own plugin manifest (`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`)
- **Virtual shell**: Same `deeplake-shell.js` — platform-agnostic

---

## Risk Assessment

| Risk | Severity | Likelihood | Notes |
|------|----------|------------|-------|
| `$CODEX_PLUGIN_ROOT` doesn't resolve | **High** | **Medium** | Nothing works if hooks can't find bundles |
| Plugin hooks not discovered | **High** | **Medium** | hooks.json may need manual install to `~/.codex/hooks.json` |
| SessionStart output format wrong | **High** | **Low** | Context injection silently fails |
| Codex adds tools that bypass PreToolUse | **High** | **Medium** | Memory interception silently breaks |
| Wiki worker uses wrong binary flags | **Medium** | **Medium** | Falls back to `claude` if `codex` not found |
| Multiple Stop → wiki spawns | **Low** | **High** | Worker handles gracefully, just wasteful |
| No assistant message in Stop | **Low** | **High** | Minor wiki quality reduction |
| PostToolUse blocking (no async) | **Low** | **Low** | 15s timeout is generous |

---

### 11. Codex sandbox blocks virtual shell rewrite (CONFIRMED)

Tested with Codex 0.118.0. The sandbox mode `workspace-write [workdir, /tmp, $TMPDIR, ~/.codex/memories]` restricts which paths the rewritten Bash command can access. Our PreToolUse hook rewrites commands to `node "/path/to/deeplake-shell.js" -c "cat /index.md"`, but the plugin bundle path (`~/.codex/plugins/cache/...`) is **outside** the sandbox allowlist.

**What works:**
- SessionStart context injection (plain text stdout) — CONFIRMED working
- All 5 hook events fire correctly
- Fast-path SQL queries that rewrite to `echo "content"` — should work (echo is a builtin)

**What doesn't work:**
- Slow-path virtual shell rewrites — the `node` command pointing to the plugin bundle is blocked by the sandbox
- Any rewritten command that references files outside the sandbox allowlist

**Possible fixes:**
1. Copy the virtual shell bundle to `/tmp/` at session start (inside sandbox)
2. Use only the fast-path SQL approach (no virtual shell fallback)
3. Bundle an MCP server instead of using PreToolUse rewriting
4. Request Codex to add plugin paths to the sandbox allowlist

### 12. SessionStart output must be plain text (CONFIRMED)

Tested with Codex 0.118.0. JSON output `{ "additionalContext": "..." }` causes "SessionStart Failed". Plain text on stdout is correctly added as developer context. This contradicts some documentation but is the confirmed behavior.

---

## Recommended Next Steps

1. **Test with real Codex installation** — verify plugin path resolution, hook discovery, and output formats
2. **Evaluate MCP server** — would eliminate the Bash-only PreToolUse limitation entirely
3. **Monitor Codex changelog** — watch for SessionEnd, expanded PreToolUse, async hooks, plugin update command
4. **Add integration tests** — simulate Codex wire format end-to-end with mock stdin/stdout
