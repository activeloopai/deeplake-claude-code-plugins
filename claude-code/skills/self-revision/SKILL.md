---
name: self-revision
description: Audit the user's own or team's Hivemind session history for behavioral anti-patterns (edit-thrashing, correction-heavy turns, abandonment, repeated instructions, frustration drift, etc.) and produce a scored report plus ready-to-paste rules for CLAUDE.md / AGENTS.md. Use when the user asks to "review my sessions", "find what's going wrong", "generate rules from my history", or otherwise wants a retrospective against Hivemind's Deeplake-backed session log.
allowed-tools: Bash Read Write Edit Glob Grep
---

# Self-Revision

This skill runs a behavioral retrospective against Hivemind's `sessions` table in Deeplake — the cloud-backed, per-org session log that Hivemind populates via its capture hooks.

Proceed in three phases: **Scope → Queries → Report**. Do not skip phases — every run should negotiate scope, persist the SQL it ran, and end with a structured report plus paste-ready rules.

---

## Phase 1 — Establish scope

Before running any query, confirm scope with the user. Ask once, combining all three questions in a single message so the user can answer them together:

1. **Whose sessions?** one user (`author = '<name>'`), several users, or the whole org.
2. **Which projects?** filter by `project` column (e.g. `hivemind`, `indra`), or all.
3. **Date range?** ISO dates against `creation_date` (default: last 30 days).

Offer a discovery query first so the user can pick from real values:

```bash
dl-query "SELECT author, COUNT(DISTINCT (message->>'session_id')) AS sessions, MIN(creation_date) AS first_seen, MAX(creation_date) AS last_seen FROM sessions GROUP BY author ORDER BY sessions DESC"
dl-query "SELECT project, COUNT(DISTINCT (message->>'session_id')) AS sessions FROM sessions GROUP BY project ORDER BY sessions DESC LIMIT 20"
```

Capture the three scope values as shell variables for every subsequent query:

```bash
SCOPE_AUTHOR="david.gyulnazaryan"        # or "" for any
SCOPE_PROJECT="hivemind"                  # or "" for any
SCOPE_FROM="2026-03-20"                   # ISO date
SCOPE_TO="2026-04-20"                     # ISO date
```

Every query below references a `/* scope */` marker. Build the fragment once and substitute it into each SQL string before running — do **not** leave the literal comment in the query. A small bash helper keeps this consistent:

```bash
scope_where() {
  cat <<EOF
(message->>'session_id') IS NOT NULL
AND ('${SCOPE_AUTHOR}'  = '' OR author  = '${SCOPE_AUTHOR}')
AND ('${SCOPE_PROJECT}' = '' OR project = '${SCOPE_PROJECT}')
AND creation_date >= '${SCOPE_FROM}'
AND creation_date <  '${SCOPE_TO}'
EOF
}

run_signal() {         # $1 = signal name, stdin = SQL with /* scope */ marker
  local name=$1; local sql; sql=$(cat)
  sql=${sql//\/\* scope \*\//$(scope_where)}
  echo "$sql" > "$RUN_DIR/$name.sql"
  dl-query "$sql"      > "$RUN_DIR/$name.json"
}
```

Then, before the signal queries, run a **scope-count check**:

```bash
dl-query "SELECT CAST(COUNT(DISTINCT (message->>'session_id')) AS BIGINT) AS sessions
          FROM sessions WHERE $(scope_where)"
```

If the count is under ~20, warn the user that the baselines are noisy and offer to widen the window before generating rules. Record the count — it goes into the report header.

---

## Phase 2 — Run the queries

### Deeplake SQL runner

The skill uses the same credentials as the capture hooks (`~/.deeplake/credentials.json`). Pick a base dir that is writable in the current environment — prefer `~/.claude/self-revision` when available, fall back to `$TMPDIR/self-revision` (or `/tmp/self-revision`) when the home directory is read-only (some subagent harnesses sandbox `~/.claude/`):

```bash
BASE_DIR=${SELF_REVISION_DIR:-$HOME/.claude/self-revision}
if ! mkdir -p "$BASE_DIR" 2>/dev/null; then
  BASE_DIR=${TMPDIR:-/tmp}/self-revision
  mkdir -p "$BASE_DIR"
fi

cat > "$BASE_DIR/dl-query.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CRED=$HOME/.deeplake/credentials.json
TOK=$(jq -r .token  "$CRED")
ORG=$(jq -r .orgId  "$CRED")
WS=$(jq  -r .workspaceId "$CRED")
URL=$(jq -r .apiUrl "$CRED")
curl -sS -X POST "$URL/workspaces/$WS/tables/query" \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "X-Activeloop-Org-Id: $ORG" \
  -d "{\"query\": $(jq -R -s . <<<"$1")}"
EOF
chmod +x "$BASE_DIR/dl-query.sh"
dl-query() { "$BASE_DIR/dl-query.sh" "$@"; }
```

Persist every SQL query and its raw JSON response under `$BASE_DIR/runs/<timestamp>/` so the report can cite them:

```bash
RUN_DIR=$BASE_DIR/runs/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN_DIR"
# per-signal files: signal-name.sql  +  signal-name.json
```

### Deeplake SQL quirks — read before writing queries

- Use LIKE / ILIKE for matching. The `~` regex operator silently returns false in this engine.
- Cast aggregates explicitly: `CAST(SUM(...) AS BIGINT)` — untyped SUM/COUNT sometimes render as null.
- JSONB access: `(message->>'field')` for text, `json_extract_path_text((message->>'tool_input')::json, 'file_path')` for nested JSON-in-a-string.
- Timestamps are strings. Cast inside aggregates — **`MIN(creation_date::timestamp)`, not `MIN(creation_date)::timestamp`**. The latter is silently parsed as `MINCAST(creation_date AS timestamp)` and errors. Same for `MAX`.
- `creation_date::timestamp` outside aggregates is fine (e.g. inside `LAG` / window functions / `EXTRACT(EPOCH FROM ...)`).
- Use `'' = ''` style guards for optional filters — do not concatenate entire `WHERE` clauses, it breaks quoting.
- Escape single quotes in SQL strings by doubling them (`don''t`).

### Filter synthetic user messages

Hivemind's `UserPromptSubmit` hook captures every injected prompt, including synthetic wrappers the harness emits around real user input. These pollute message-based signals (correction-heavy, keep-going-loop, repeated-instructions, negative-drift). Use this reusable predicate in the `WHERE` of every user-message signal:

```sql
AND (message->>'content') IS NOT NULL
AND (message->>'content') NOT LIKE '<task-notification%'
AND (message->>'content') NOT LIKE '<system-reminder%'
AND (message->>'content') NOT LIKE '<command-name%'
AND (message->>'content') NOT LIKE '<command-message%'
AND (message->>'content') NOT LIKE '<local-command%'
AND (message->>'content') NOT LIKE '<recalled-memories%'
AND (message->>'content') NOT LIKE 'Caveat: The messages below%'
AND (message->>'content') NOT LIKE 'DEEPLAKE MEMORY:%'
```

Bake this into a helper:

```bash
human_only() {
  cat <<'EOF'
AND (message->>'content') NOT LIKE '<task-notification%'
AND (message->>'content') NOT LIKE '<system-reminder%'
AND (message->>'content') NOT LIKE '<command-name%'
AND (message->>'content') NOT LIKE '<command-message%'
AND (message->>'content') NOT LIKE '<local-command%'
AND (message->>'content') NOT LIKE '<recalled-memories%'
AND (message->>'content') NOT LIKE 'Caveat: The messages below%'
AND (message->>'content') NOT LIKE 'DEEPLAKE MEMORY:%'
EOF
}
```

### Signals — one query per anti-pattern

Each query below filters by the scope. Save each one to `$RUN_DIR/<signal>.sql` before running, and the result to `$RUN_DIR/<signal>.json`.

#### 1. edit-thrashing — same file edited ≥5×

```sql
WITH edits AS (
  SELECT (message->>'session_id') AS sid, author, project,
         (message->>'tool_name')  AS tool,
         json_extract_path_text((message->>'tool_input')::json, 'file_path') AS fp
  FROM sessions
  WHERE (message->>'type') = 'tool_call'
    AND (message->>'tool_name') IN ('Edit','Write','MultiEdit','NotebookEdit')
    AND /* scope */
)
SELECT sid, author, project, fp, CAST(COUNT(*) AS BIGINT) AS edits
FROM edits
WHERE fp IS NOT NULL AND fp <> ''
GROUP BY sid, author, project, fp
HAVING COUNT(*) >= 5
ORDER BY edits DESC
```

Severity: `>=5 medium`, `>=10 high`, `>=20 critical`.

#### 2. excessive-exploration — read:edit ratio ≥10:1

```sql
WITH tc AS (
  SELECT (message->>'session_id') AS sid, author, project,
    CAST(SUM(CASE WHEN (message->>'tool_name') IN ('Read','Grep','Glob','LS','NotebookRead') THEN 1 ELSE 0 END) AS BIGINT) AS reads,
    CAST(SUM(CASE WHEN (message->>'tool_name') IN ('Edit','Write','MultiEdit','NotebookEdit') THEN 1 ELSE 0 END) AS BIGINT) AS edits
  FROM sessions
  WHERE (message->>'type') = 'tool_call' AND /* scope */
  GROUP BY sid, author, project
)
SELECT sid, author, project, reads, edits,
       ROUND(reads::numeric / NULLIF(edits, 0), 1) AS ratio
FROM tc
WHERE edits > 0 AND reads::numeric / edits >= 10
ORDER BY ratio DESC
```

Severity: `>=10 medium`, `>=20 high`.
Also flag **read-only-session** when `edits = 0 AND reads > 20` (severity medium).

#### 3. restart-cluster — many sessions started within 30 min

```sql
WITH starts AS (
  SELECT (message->>'session_id') AS sid, author, project,
         MIN(creation_date::timestamp) AS started   -- cast INSIDE the aggregate
  FROM sessions
  WHERE /* scope */
  GROUP BY sid, author, project
),
lagged AS (
  SELECT author, project, sid, started,
         LAG(started) OVER (PARTITION BY author ORDER BY started) AS prev_started
  FROM starts
)
SELECT author, project, CAST(COUNT(*) AS BIGINT) AS restarts_within_30m
FROM lagged
WHERE prev_started IS NOT NULL
  AND EXTRACT(EPOCH FROM (started - prev_started)) < 1800
GROUP BY author, project
ORDER BY restarts_within_30m DESC
```

Severity: `>=2 high`, `>=5 critical`.

#### 4. high-abandonment-rate — many sessions with <3 user messages

Group by `sid` alone (not `sid, project`) — sessions that span multiple `cwd`s can otherwise be double-counted.

```sql
WITH s AS (
  SELECT (message->>'session_id') AS sid,
         MAX(author) AS author,
         CAST(SUM(CASE WHEN (message->>'type')='user_message' THEN 1 ELSE 0 END) AS BIGINT) AS user_msgs
  FROM sessions WHERE /* scope */
  GROUP BY sid
)
SELECT author,
       CAST(COUNT(*) AS BIGINT) AS sessions,
       CAST(SUM(CASE WHEN user_msgs < 3 THEN 1 ELSE 0 END) AS BIGINT) AS short_sessions,
       ROUND(SUM(CASE WHEN user_msgs < 3 THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 3) AS short_ratio
FROM s
GROUP BY author
HAVING COUNT(*) >= 5
ORDER BY short_ratio DESC
```

Severity: `>0.3 high`, `>0.5 critical`.

#### 5. correction-heavy — ≥20 % of user messages start with a correction marker

Compute the LIKE chain once in a CTE (regex `~` does not work in this engine). Always include the `human_only` filter.

```sql
WITH um AS (
  SELECT author,
         LOWER(TRIM(message->>'content')) AS txt
  FROM sessions
  WHERE (message->>'type')='user_message' AND /* scope */
    /* human_only */
),
flagged AS (
  SELECT author,
         CASE WHEN
              txt LIKE 'no %' OR txt LIKE 'no,%' OR txt LIKE 'no.%' OR txt LIKE 'no!%'
           OR txt LIKE 'nope%' OR txt LIKE 'wrong%'
           OR txt LIKE 'that''s not%' OR txt LIKE 'thats not%'
           OR txt LIKE 'not what i%'
           OR txt LIKE 'i said%' OR txt LIKE 'i meant%' OR txt LIKE 'i asked%' OR txt LIKE 'i wanted%'
           OR txt LIKE 'actually %' OR txt LIKE 'actually,%'
           OR txt LIKE 'wait %'     OR txt LIKE 'wait,%'
           OR txt LIKE 'stop%'      OR txt LIKE 'instead %' OR txt LIKE 'instead,%'
           OR txt LIKE 'don''t do that%' OR txt LIKE 'dont do that%'
           OR txt LIKE 'why did you%'
         THEN 1 ELSE 0 END AS is_corr
  FROM um
)
SELECT author,
       CAST(SUM(is_corr) AS BIGINT) AS corrections,
       CAST(COUNT(*)     AS BIGINT) AS total_msgs,
       ROUND(SUM(is_corr)::numeric / NULLIF(COUNT(*),0), 3) AS rate
FROM flagged
GROUP BY author
HAVING COUNT(*) >= 20
   AND SUM(is_corr)::numeric / NULLIF(COUNT(*),0) > 0.20
ORDER BY rate DESC
```

Before running, splice the `human_only` helper into the `/* human_only */` marker the same way you splice `/* scope */`.

Severity: `>0.2 high`, `>0.4 critical`.

#### 6. keep-going-loop — ≥2 "keep going" class messages

Tight patterns only — bare `LIKE 'continue%'` over-matches legitimate imperatives like "continue the XYZ task after …". A keep-going nudge is almost always short (<80 chars) and either bare or punctuated.

```sql
WITH um AS (
  SELECT author, LOWER(TRIM(message->>'content')) AS txt, LENGTH(TRIM(message->>'content')) AS len
  FROM sessions WHERE (message->>'type')='user_message' AND /* scope */
    /* human_only */
)
SELECT author,
  CAST(SUM(CASE WHEN len < 80 AND (
       txt = 'keep going' OR txt LIKE 'keep going.%' OR txt LIKE 'keep going!%'
    OR txt = 'continue'   OR txt LIKE 'continue.%'   OR txt LIKE 'continue!%'
    OR txt = 'more'       OR txt = 'finish'          OR txt = 'go on'
    OR txt LIKE 'keep at it%'
    OR txt LIKE 'don''t stop%' OR txt LIKE 'dont stop%'
    OR txt LIKE 'you''re not done%' OR txt LIKE 'not done%'
    OR txt LIKE 'keep iterating%'
  ) THEN 1 ELSE 0 END) AS BIGINT) AS keep_going,
  CAST(COUNT(*) AS BIGINT) AS total
FROM um
GROUP BY author HAVING COUNT(*) >= 10
ORDER BY keep_going DESC
```

Severity: `>=2 medium`, `>=4 high`.

#### 7. rapid-corrections — user reply <10 s after assistant_message

```sql
WITH seq AS (
  SELECT (message->>'session_id') AS sid, author, project,
         (message->>'type') AS t,
         creation_date::timestamp AS ts,
         LAG((message->>'type'))          OVER (PARTITION BY (message->>'session_id') ORDER BY creation_date) AS prev_t,
         LAG(creation_date::timestamp)    OVER (PARTITION BY (message->>'session_id') ORDER BY creation_date) AS prev_ts
  FROM sessions WHERE /* scope */
)
SELECT author,
  CAST(SUM(CASE
    WHEN t='user_message' AND prev_t='assistant_message'
         AND EXTRACT(EPOCH FROM (ts - prev_ts)) BETWEEN 0 AND 10
    THEN 1 ELSE 0 END) AS BIGINT) AS rapid_followups
FROM seq GROUP BY author
ORDER BY rapid_followups DESC
```

Severity: `>=3 medium`, `>=5 high`.

#### 8. high-turn-ratio — user messages per assistant turn

Note: Hivemind's `assistant_message` is emitted once per Stop/SubagentStop — one row per completed turn, not per assistant event. Interpret direction, not magnitude.

```sql
SELECT (message->>'session_id') AS sid, author,
  CAST(COUNT(*) FILTER (WHERE (message->>'type')='user_message')      AS BIGINT) AS u,
  CAST(COUNT(*) FILTER (WHERE (message->>'type')='assistant_message') AS BIGINT) AS a,
  ROUND(COUNT(*) FILTER (WHERE (message->>'type')='user_message')::numeric
        / NULLIF(COUNT(*) FILTER (WHERE (message->>'type')='assistant_message'),0), 2) AS turn_ratio
FROM sessions WHERE /* scope */
GROUP BY sid, author
HAVING COUNT(*) FILTER (WHERE (message->>'type')='user_message') >= 5
   AND (COUNT(*) FILTER (WHERE (message->>'type')='user_message'))::numeric
      / NULLIF(COUNT(*) FILTER (WHERE (message->>'type')='assistant_message'),0) > 1.5
ORDER BY turn_ratio DESC
```

Severity: `>1.5 medium`, `>2.5 high`.

#### 9. repeated-instructions — high word-overlap between nearby user messages

Jaccard similarity is not a Deeplake builtin. Fetch human-only user messages and compute in bash — the `human_only` filter is critical, otherwise recalled-memory and reminder preambles self-match at similarity 1.0 and dominate the signal.

```sql
SELECT (message->>'session_id') AS sid, author,
       creation_date, message->>'content' AS content
FROM sessions
WHERE (message->>'type')='user_message' AND /* scope */
  /* human_only */
ORDER BY sid, creation_date
```

For each session, slide a window of 5 messages and compute Jaccard over lowercased word sets. Flag pairs ≥0.60 similarity. Severity: `>=2 high`, `>=4 critical`.

Reference implementation (awk, no external deps):

```bash
jq -r '.rows[] | [.[0], .[3]] | @tsv' "$RUN_DIR/09-repeated-instructions.json" \
| awk -F'\t' '
  function jacc(a, b,   ta, tb, na, nb, i, j, inter, uni) {
    na = split(tolower(a), ta, /[^a-z0-9]+/)
    nb = split(tolower(b), tb, /[^a-z0-9]+/)
    delete seenA; delete seenB
    for (i=1;i<=na;i++) if (length(ta[i])>2) seenA[ta[i]]=1
    for (j=1;j<=nb;j++) if (length(tb[j])>2) seenB[tb[j]]=1
    for (k in seenA) { if (k in seenB) inter++; uni++ }
    for (k in seenB) if (!(k in seenA)) uni++
    return uni==0 ? 0 : inter/uni
  }
  { sid=$1; txt[NR]=$2; sids[NR]=sid }
  END {
    for (i=1;i<=NR;i++) for (j=i+1;j<=i+5 && j<=NR;j++)
      if (sids[i]==sids[j]) {
        s=jacc(txt[i], txt[j])
        if (s>=0.60) printf "%s\t%.2f\t%s\t%s\n", sids[i], s, substr(txt[i],1,80), substr(txt[j],1,80)
      }
  }' | sort -k1,1 -k2,2rn > "$RUN_DIR/09-repeated-instructions.pairs.tsv"
```

Count pairs per session and apply severity thresholds.

#### 10. negative-drift — messages shrink and get more corrective over time

Pull the same human-only user-message stream as #9. Split each session's user messages into halves, compute `avg_len` and correction-rate per half, then:
`drift = (firstLen - secondLen)/firstLen * 5 + (secondRate - firstRate) * 10`. Flag `> 2 medium`, `> 5 high`.

---

## Phase 3 — Report + rules

Write the report to `$RUN_DIR/report.md`. Use this exact template so multiple runs diff cleanly:

````markdown
# Self-Revision Report

- **Scope**: author=`<author or *>`, project=`<project or *>`, `<from>` → `<to>`
- **Sessions in scope**: <n>
- **Generated**: <iso timestamp>
- **Queries**: see `$RUN_DIR/*.sql` + `*.json`

## Health score

Compute deterministically with the bundled script — never hand-tally.

```bash
bash "$(dirname "$(readlink -f "${BASH_SOURCE:-$0}")")/score.sh" "$RUN_DIR"
```
````

(Or, from outside the skill dir: `bash <skill-dir>/score.sh "$RUN_DIR"`.)

The script globs `$RUN_DIR/<NN>-*.json`, classifies each row's severity from one numeric column (thresholds hardcoded to match the signal queries above), and prints a breakdown plus:

```
Total penalty: <n>
Health score:  <100 - n, clamped> / 100
```

Paste those two lines verbatim into the report under this header. Do not round, re-weight, or add signals the script doesn't know about — the whole point is that two agents auditing the same scope land on the same number.

## Signals fired

| Signal                | Severity | Count | Example                                       |
| --------------------- | -------- | ----- | --------------------------------------------- |
| edit-thrashing        | critical | 3     | `src/app/page.tsx` (36×, session `a9bb65a8…`) |
| excessive-exploration | high     | 5     | 40 reads / 2 edits, session `c58467b0…`       |
| restart-cluster       | high     | 218   | `<author>`                                    |
| …                     |          |       |                                               |

For each signal, include a collapsible details block with top 5 offending rows.

## Rules (auto-generated by self-revision)

Based on <n> sessions (author=…, project=…, <from>→<to>).

- <rule 1>
- <rule 2>
- …

````

### Rule templates — map signals → rules

Emit a rule only when its source signal fired. Phrase rules as imperatives directed at future-agent-self. Drop any rule whose signal did not trigger; do not pad the output.

| Signal (fired) | Emit rule |
|---|---|
| edit-thrashing | "Read the full file before editing. Plan all changes, then make ONE complete edit." |
| excessive-exploration / read-only-session | "Bound exploration: after 10 reads without an edit, either make the edit or ask the user to confirm scope." |
| restart-cluster | "If the last session abandoned in under a minute, check the restart reason before restarting the task — don't just retry." |
| high-abandonment-rate | "When the user gives a short or one-line prompt, ask one clarifying question before tool use if the target is ambiguous." |
| correction-heavy | "When the user corrects you, stop, re-read their message, and restate the intent before continuing." |
| keep-going-loop | "Complete the FULL task before stopping. A 'done' claim must account for every sub-item in the request." |
| rapid-corrections | "If the user replies within 10s with a short message, treat it as a correction — re-read and adjust, do not continue down the previous path." |
| repeated-instructions | "Every few turns, re-read the original request to make sure you haven't drifted." |
| high-turn-ratio / negative-drift | "If the user's messages are getting shorter and more corrective, pause, summarize your current understanding, and ask them to confirm before proceeding." |

### Suggest edits to CLAUDE.md / AGENTS.md

After writing `report.md`, offer to patch the target repo's agent instructions file. Order of precedence:

1. `${SCOPE_CWD}/CLAUDE.md`
2. `${SCOPE_CWD}/AGENTS.md`
3. `${SCOPE_CWD}/README.md` — only if the user explicitly opts in (these rules are agent-directed; README is human-directed)

Use a single markdown section so subsequent runs can locate and replace it idempotently:

```markdown
<!-- BEGIN self-revision rules -->
## Rules (auto-generated by self-revision)

Based on <n> sessions …

- …
<!-- END self-revision rules -->
````

On each subsequent run:

1. If the marker pair exists, **replace** the block between the markers in place.
2. If it does not exist, **append** the block at the end of the file (with one blank line of separation).
3. Always confirm with the user before writing — show the proposed diff first.

Never silently overwrite text outside the markers. Never commit the change; leave that to the user.

---

## Operating rules for this skill

- Always run Phase 1 first. Do not pick a default scope silently.
- Always persist SQL + response JSON under `$RUN_DIR/` before summarizing — the report cites them.
- Cite source session IDs in examples so the user can open the raw transcript in `~/.deeplake/memory/sessions/<author>/*.jsonl`.
- If the user's Deeplake workspace has < ~20 sessions in scope, warn that the baselines are noisy and offer to widen the window before generating rules.
