---
description: Log an experiment result to the hivemind experiment log
allowed-tools: Bash
argument-hint: log <change_id> <metric> <status> "<description>" [--metadata <json>]
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/log-experiment.js" $ARGUMENTS
```

Subcommands:

- `log <change_id> <metric> <status> "<description>" [--metadata <json>] [--metadata-file <path>] [--table <name>]` — append a row to the experiment log.
- `promote <change_id> [--id <uuid>] [--unset] [--table <name>]` — mark an experiment as the new global baseline (or unset it).
- `init [--table <name>]` — create the experiment table without inserting a row.

Default table: `experiments` (override with `--table` or `HIVEMIND_EXPERIMENT_TABLE`).
The schema (`change_identifier`, `metric`, `metadata`, `status`, `description`, `global_promoted`, `timestamp`) is parallelism-agnostic — works for git worktrees, branches, patch hashes, A/B variant ids, prompt versions, or any opaque change reference.
