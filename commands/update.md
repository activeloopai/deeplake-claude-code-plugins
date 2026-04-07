---
description: Update the Deeplake Hivemind plugin to the latest version
allowed-tools: Bash
---

Run all scopes to ensure the plugin is updated regardless of how it was installed:

```bash
claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope user 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope project 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope local 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope managed 2>/dev/null; echo "Update complete."
```

Tell the user to run `/reload-plugins` to apply the update.
