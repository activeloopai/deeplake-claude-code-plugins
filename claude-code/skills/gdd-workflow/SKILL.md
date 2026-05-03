---
name: gdd-workflow
description: Use for Goal-Driven Development (GDD) when running experiments, comparing implementation variants, or coordinating with other agents on measurable project changes. Always inspect shared memory for prior related work and log every experimental outcome through the /hivemind:gdd command.
allowed-tools: Bash
---

# Goal-Driven Development (GDD) Workflow

Use this skill for experiment-driven development where outcomes are measured and need to be remembered across agents, branches, variants, or sessions.

GDD is coordination discipline, allowing to coordinate and promote the best outcomes across different project versions.

## Start With Shared Context

Before choosing or running an experiment:

1. Inspect project memory for related attempts, baselines, failures, and promoted results.
2. Read `~/.deeplake/memory/index.md` first, then relevant summaries, if any, via the hivemind-memory skill;
3. Identify the current baseline (if it exists), and/or the current best outcome
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

Use `metric` for the project's primary comparable number. If the experiment failed before producing the primary metric, use a neutral numeric sentinel such as `0` and set `status` to `crash` or `failed`; put the error summary in `description` or `metadata`.

Suggested statuses:

- `baseline`: reference result for comparison.
- `keep`: outcome is worth preserving or investigating further.
- `discard`: completed but not worth keeping due to low quality, excessive complexity or worse performance.
- `crash`: failed before a valid metric was produced.

Use metadata for structured context that should be queryable later: commit, branch, test command, dataset, seed, runtime, memory, model, configuration, agent id, run tag, or links to logs.

## Promote Best Outcomes

When a result becomes the shared reference point, promote it:

```bash
/hivemind:gdd promote <change_id> [--id <uuid>] [--unset] [--table <name>]
```

Promotion means "this is the current best result known to me, and the other agents should compare against."

Initialize the table explicitly when needed:

```bash
/hivemind:gdd init [--table <name>]
```

## Coordinate With Other Agents

When other agents are working on the same project:

1. Read shared memory before assigning, starting, or evaluating work.
2. Each row should have a distinct `change_id` (change_identifier column). Typically, this a commit hash, unique version number etc.
3. When used, sub-agents should be instructed to log their results with the GDD command, according to the same rules.
4. Review logged results before deciding what to keep, promote, rerun, or abandon.

The objective is cumulative learning: agents should not repeat failed ideas unknowingly, and useful outcomes should remain discoverable after the session ends.
