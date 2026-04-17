#!/usr/bin/env python3
"""
Repro: Deeplake query endpoint drops one of two rapid UPDATEs on the same row.

Pattern:
  - Row exists (INSERTed earlier).
  - Client sends UPDATE A (e.g. summary column).
  - Client sends UPDATE B (e.g. description column) ~milliseconds later.
  - Server returns 200 OK with row_count=0 for BOTH calls.
  - Final stored state: only the second UPDATE landed (sometimes neither).

Control: combining both SETs into a single UPDATE statement works correctly.

Usage:
  DEEPLAKE_TOKEN=... DEEPLAKE_ORG_ID=... DEEPLAKE_WORKSPACE_ID=... \\
    DEEPLAKE_API_URL=https://api.deeplake.ai DEEPLAKE_TABLE=memory \\
    python3 deeplake-update-bug-repro.py

Falls back to ~/.deeplake/credentials.json if env vars are missing.
"""
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path


def load_creds():
    creds_path = Path.home() / ".deeplake" / "credentials.json"
    file_creds = {}
    if creds_path.exists():
        file_creds = json.loads(creds_path.read_text())
    token = os.environ.get("DEEPLAKE_TOKEN") or file_creds.get("token")
    org_id = os.environ.get("DEEPLAKE_ORG_ID") or file_creds.get("orgId")
    ws = os.environ.get("DEEPLAKE_WORKSPACE_ID") or file_creds.get("workspaceId", "default")
    api = os.environ.get("DEEPLAKE_API_URL") or file_creds.get("apiUrl", "https://api.deeplake.ai")
    table = os.environ.get("DEEPLAKE_TABLE", "memory")
    if not token or not org_id:
        sys.exit("Missing DEEPLAKE_TOKEN or DEEPLAKE_ORG_ID (env or ~/.deeplake/credentials.json)")
    return token, org_id, ws, api, table


def query(api, ws, org, token, sql):
    req = urllib.request.Request(
        f"{api}/workspaces/{ws}/tables/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": org,
        },
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    token, org, ws, api, table = load_creds()
    print(f"Target: org={org} workspace={ws} table={table} api={api}")

    def q(sql):
        return query(api, ws, org, token, sql)

    test_id = str(uuid.uuid4())
    test_path = f"/_repro/update-bug-{int(time.time())}-{test_id[:8]}.md"

    # 1) INSERT a fresh row with a small placeholder value.
    placeholder = "PLACEHOLDER"
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    insert_sql = (
        f"INSERT INTO \"{table}\" "
        f"(id, path, filename, summary, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) "
        f"VALUES ('{test_id}', '{test_path}', 'repro.md', E'{placeholder}', 'repro', 'text/markdown', "
        f"{len(placeholder)}, 'repro', 'desc-initial', 'repro', '{now}', '{now}')"
    )
    status, body = q(insert_sql)
    print(f"\n[1] INSERT status={status} body={body}")

    # 2) BUG PATTERN: two rapid UPDATEs on different columns of the same row.
    print("\n[2] Sending two rapid UPDATEs (summary then description)...")
    summary_new = "A" * 3000
    desc_new = "DESCRIPTION-AFTER-BUG"

    t0 = time.perf_counter()
    s1, b1 = q(f"UPDATE \"{table}\" SET summary = E'{summary_new}', size_bytes = {len(summary_new)} WHERE path = '{test_path}'")
    s2, b2 = q(f"UPDATE \"{table}\" SET description = E'{desc_new}' WHERE path = '{test_path}'")
    elapsed = time.perf_counter() - t0
    print(f"    UPDATE 1 status={s1} row_count={b1.get('row_count') if isinstance(b1, dict) else '?'}")
    print(f"    UPDATE 2 status={s2} row_count={b2.get('row_count') if isinstance(b2, dict) else '?'}")
    print(f"    sent both in {elapsed*1000:.0f} ms")

    # 3) Wait well beyond any eventual-consistency window, then read state.
    time.sleep(8)
    _, verify = q(f"SELECT size_bytes, LENGTH(summary) AS sum_len, description FROM \"{table}\" WHERE path = '{test_path}'")
    print(f"\n[3] Stored state after 8s: {verify}")

    if isinstance(verify, dict) and verify.get("rows"):
        size_bytes, sum_len, description = verify["rows"][0]
        summary_applied = size_bytes == len(summary_new) and sum_len == len(summary_new)
        description_applied = description == desc_new
        print(f"    summary UPDATE applied:     {summary_applied} (expected size={len(summary_new)}, got {size_bytes})")
        print(f"    description UPDATE applied: {description_applied} (expected '{desc_new}', got '{description}')")
        if not summary_applied or not description_applied:
            print("\n    >>> BUG REPRODUCED: at least one UPDATE was silently dropped <<<")

    # 4) CONTROL: combine both SETs into a single UPDATE.
    print("\n[4] Retrying with a single combined UPDATE...")
    summary_new2 = "B" * 4000
    desc_new2 = "DESCRIPTION-COMBINED"
    s3, b3 = q(
        f"UPDATE \"{table}\" SET summary = E'{summary_new2}', size_bytes = {len(summary_new2)}, "
        f"description = E'{desc_new2}' WHERE path = '{test_path}'"
    )
    print(f"    combined UPDATE status={s3} row_count={b3.get('row_count') if isinstance(b3, dict) else '?'}")

    time.sleep(8)
    _, verify2 = q(f"SELECT size_bytes, LENGTH(summary) AS sum_len, description FROM \"{table}\" WHERE path = '{test_path}'")
    print(f"    stored state after 8s: {verify2}")
    if isinstance(verify2, dict) and verify2.get("rows"):
        size_bytes, sum_len, description = verify2["rows"][0]
        both_applied = size_bytes == len(summary_new2) and sum_len == len(summary_new2) and description == desc_new2
        print(f"    combined UPDATE applied:    {both_applied}")

    # 5) Cleanup
    q(f"DELETE FROM \"{table}\" WHERE path = '{test_path}'")
    print(f"\n[5] cleaned up test row at {test_path}")


if __name__ == "__main__":
    main()
