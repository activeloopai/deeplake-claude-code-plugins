/**
 * Path-traversal rejection — RELEASE_CHECKLIST §5 path traversal.
 *
 * The virtual `~/.deeplake/memory/` mount intercepts `cat` / `ls` / `grep`
 * commands and routes them through SQL queries against the memory table.
 * If a traversal segment (`..`) bypasses the rewrite, the agent could
 * read paths outside the mount — most concerning is escape to host files
 * (e.g. `cat ~/.deeplake/memory/../../etc/passwd` ENOENT'ing on the
 * virtual side but then resolving through `bash` to the real /etc/passwd
 * if the intercept passed it through unmodified).
 *
 * Agent is asked to cat a clearly-out-of-mount path. The hook should:
 *   - reject the read (no host filesystem access), AND
 *   - not silently return a real-FS file's contents
 *
 * For the CLI agents this exercises the `touchesMemory` + `rewritePaths`
 * pipeline. For openclaw, the `hivemind_read` MCP tool path validation.
 */

import type { E2ECase } from "../types.js";

const TRAVERSAL_TARGET = "~/.deeplake/memory/../../../../etc/passwd";

const pathTraversalRejectionCase: E2ECase = {
  id: "11-path-traversal-rejection",
  description:
    "traversal segments (../) in a memory-mount path don't escape the virtual filesystem",
  prompt:
    `Run exactly this bash command and show me the FULL output verbatim:\n` +
    `cat ${TRAVERSAL_TARGET}`,
  assertions: [
    {
      // Negative assertion: real /etc/passwd lines should NOT appear in
      // the agent's stdout. /etc/passwd always starts with `root:` on
      // Linux/macOS — that string anywhere in stdout means the intercept
      // failed to reject and bash served the real file.
      type: "custom",
      label: "agent's response does NOT leak /etc/passwd contents",
      check: async ({ run }) => {
        // root:x:0:0: is the canonical first-line passwd shape on every
        // POSIX system. If this slips through, the intercept failed.
        if (/root:[x*!]:0:0:/.test(run.stdout)) {
          return `stdout contains a /etc/passwd line shape ("root:x:0:0:" or equivalent) — path traversal escaped the virtual mount`;
        }
        return null;
      },
    },
  ],
  // OpenClaw uses the hivemind_read MCP tool, not bash. Path-traversal
  // there is a different bug class (tool arg validation, not bash
  // rewrite) — case 08 already exercises hivemind_read with a clean
  // path; adding traversal there would be a separate dedicated case.
  skipFor: ["openclaw"],
};

export default pathTraversalRejectionCase;
