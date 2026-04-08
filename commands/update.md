---
description: Update the Deeplake Hivemind plugin to the latest version
allowed-tools: Bash
---

First refresh the marketplace cache, then update across all scopes:

```bash
claude plugin marketplace update deeplake-claude-code-plugins 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope user 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope project 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope local 2>/dev/null; claude plugin update deeplake-hivemind@deeplake-claude-code-plugins --scope managed 2>/dev/null; echo "Done."
```

Tell the user to run `/reload-plugins` to apply the update.
