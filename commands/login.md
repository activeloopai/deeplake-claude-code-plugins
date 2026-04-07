---
description: Log in to Deeplake and select your organization
allowed-tools: Bash
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/auth-login.js" login
```

Present the output to the user. If login succeeds, confirm which organization they're logged into.

If login fails, show the error and suggest the user check their internet connection or try again.
