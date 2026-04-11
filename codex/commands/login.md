---
description: Log in to Hivemind and select your organization
allowed-tools: Bash
---

Run:

```bash
node "$CODEX_PLUGIN_ROOT/bundle/commands/auth-login.js" login
```

If login succeeds, show this welcome message. Include the organization name from the command output:

Welcome to Hivemind!

Current org: **{org name from output}**

Your Codex agents can now share memory across sessions, teammates, and machines.

Get started:
1. Verify sync: spin up multiple sessions and confirm agents share context
2. Invite a teammate: run `node "$CODEX_PLUGIN_ROOT/bundle/commands/auth-login.js" invite <email> <role>`
3. Switch orgs: run `node "$CODEX_PLUGIN_ROOT/bundle/commands/auth-login.js" org list`

If login fails, show the error and suggest the user check their internet connection or try again.
