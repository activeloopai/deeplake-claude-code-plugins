---
name: gdd-workflow
description: Use when running experiments, comparing implementation variants, or coordinating with other agents on measurable project changes. Always inspect shared memory for prior related work and log every experimental outcome through the current hivemind gdd command.
allowed-tools: Bash
---

# GDD

Use this skill for experiment-driven development where outcomes need to be remembered across agents, branches, variants, or sessions.

GDD is coordination discipline, not a compute or parallelism model. Do not require multiple agents, worktrees, cloud runners, or a specific test harness unless the user or project already requires them. If multiple agents are used, each agent should follow the same memory and logging rules.

## Start With Shared Context

Before choosing or running an experiment:

1. Inspect project memory for related attempts, baselines, failures, and promoted results.
2. Read `~/.deeplake/memory/index.md` first, then relevant summaries; use `grep` for project names, change ids, metrics, and error signatures.
3. Identify the current baseline or explicitly log that no reliable baseline exists.
4. Choose a stable `change_id` for the change under test, such as a branch name, commit hash, worktree label, prompt version, config name, or patch identifier.

## Log Every Outcome

Every experimental attempt should produce a GDD row, including failures and inconclusive runs. Do not only log wins.

Use the current hivemind GDD command:

```bash
/hivemind:gdd log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]
```

If a slash command is unavailable but the installed plugin path is known, run the same command implementation through the plugin bundle:

```bash
node "<plugin-root>/bundle/commands/gdd.js" log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]
```

For Codex installs, the default plugin root is usually `~/.codex/hivemind`. For Claude Code slash-command execution, the plugin command itself resolves the bundle path.

Use `metric` for the project's primary comparable number. If the experiment failed before producing the primary metric, use a neutral numeric sentinel such as `0` and set `status` to `crash` or `failed`; put the error summary in `description` or `metadata`.

Suggested statuses:

- `baseline`: reference result for comparison.
- `keep`: outcome is worth preserving or investigating further.
- `discard`: completed but not worth keeping.
- `crash`: failed before a valid metric was produced.
- `inconclusive`: ran, but the result cannot support a decision.

Use metadata for structured context that should be queryable later: commit, branch, test command, dataset, seed, runtime, memory, model, configuration, agent id, run tag, or links to logs.

## Promote Baselines

When a result becomes the shared reference point, promote it:

```bash
/hivemind:gdd promote <change_id> [--id <uuid>] [--unset] [--table <name>]
```

Promotion means "this is the current result other agents should compare against." It does not imply a git merge, deployment, or architectural endorsement by itself.

Initialize the table explicitly when needed:

```bash
/hivemind:gdd init [--table <name>]
```

## Coordinate With Other Agents

When other agents are working on the same project:

1. Read shared memory before assigning, starting, or evaluating work.
2. Give each agent a distinct `change_id` or metadata tag so results can be separated.
3. Tell agents to log successes, failures, and discarded attempts with the GDD command.
4. Review logged results before deciding what to keep, promote, rerun, or abandon.

The objective is cumulative learning: agents should not repeat failed ideas unknowingly, and useful outcomes should remain discoverable after the session ends.
