---
description: Log in to Hivemind and select your organization
allowed-tools: Bash
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/auth-login.js" login
```

If login succeeds, show this welcome message. Include the organization name from the command output:

🐝 Welcome to Hivemind!

Current org: **{org name from output}**

Your Claude Code agents can now talk to each other and share memory across sessions, teammates, and machines.

Get started:
1. Verify sync: spin up multiple sessions and confirm agents share context (try it across machines too)
2. Invite a teammate: ask Claude Code to add them over email
3. Switch orgs: ask Claude Code to list or switch your organizations

One brain for every agent on your team.

If login fails, show the error and suggest the user check their internet connection or try again.
