---
name: deeplake-memory
description: Cloud-backed persistent memory for AI agents powered by DeepLake. This plugin automatically captures all tool calls to ~/.deeplake/memory/. Use when the user wants to search, recall, or browse past session activity.
allowed-tools: Grep Read Bash
---

# DeepLake Memory

This plugin has two hooks that work automatically:

## Hook 1: Auto-Capture (PostToolUse)
Every tool call in your session is automatically captured to `~/.deeplake/memory/session_<id>.jsonl`. You don't need to do anything — it happens in the background.

## Hook 2: Memory Search (PreToolUse)
When you search `~/.deeplake/memory/`, the hook intercepts and searches across all captured sessions.

## How to Search Memory

To search past sessions, use Grep on the memory directory:

```
Grep pattern="auth bug" path="~/.deeplake/memory"
```

Or read a specific session file:

```
Read file_path="~/.deeplake/memory/session_<id>.jsonl"
```

The search hook will intercept these calls and return matching results from all stored sessions.

## What Gets Captured

Every tool call is stored as a JSONL entry with:
- `session_id` — which session it came from
- `tool_name` — Read, Write, Edit, Bash, Grep, Glob, etc.
- `tool_input` — what was passed to the tool
- `tool_response` — what the tool returned
- `timestamp` — when it happened
