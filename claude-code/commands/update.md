---
description: Update the Hivemind plugin to the latest version
allowed-tools: Bash
---

First refresh the marketplace cache, then update across all scopes:

```bash
claude plugin marketplace update hivemind 2>/dev/null; claude plugin update hivemind@hivemind --scope user 2>/dev/null; claude plugin update hivemind@hivemind --scope project 2>/dev/null; claude plugin update hivemind@hivemind --scope local 2>/dev/null; claude plugin update hivemind@hivemind --scope managed 2>/dev/null; echo "Done."
```

Tell the user to run `/reload-plugins` to apply the update.
