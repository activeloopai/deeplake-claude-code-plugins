/**
 * cat /index.md works through the virtual mount.
 *
 * The agent is asked to read the synthesized memory index. With the
 * memory-mount intercept wired correctly, `cat ~/.deeplake/memory/index.md`
 * returns a bounded markdown table from the SQL fast-path. Without it,
 * the agent shells out to the real FS and gets ENOENT.
 *
 * We assert that the agent's stdout contains the index's table header
 * (which the synthesized markdown always emits). The exact header text
 * is stable across versions — we anchor on the `Created` / `Last Updated`
 * column names that the virtual index always renders.
 *
 * Skipped on openclaw (its read surface is the hivemind_read MCP tool;
 * see case 08). Every CLI agent runs this case.
 */

import type { E2ECase } from "../types.js";

const catIndexMdCase: E2ECase = {
  id: "02-cat-index-md",
  description:
    "agent shells `cat ~/.deeplake/memory/index.md` and the virtual mount returns the index table",
  prompt:
    "Run exactly this bash command and show me its full output, then say 'done':\n" +
    "cat ~/.deeplake/memory/index.md",
  assertions: [
    // The agent's stdout is the real signal: did the virtual mount
    // synthesize the index and return it through the intercept, vs the
    // bash command falling through to a real-FS ENOENT? Pre-tool-use's
    // own log line for this path isn't a reliable marker — the bash-
    // command-compiler returns the synthesized content WITHOUT logging
    // a "direct read" line for the cat-single-file case, so anchoring
    // on the log substring fails even when the intercept worked.
    {
      type: "stdout-matches",
      regex: /Last Updated|Created|Project|Description/,
      label: "agent saw the virtual index's table headers (intercept fired and returned synthesized index)",
    },
  ],
  // OpenClaw doesn't shell out to bash — its agent's read path is the
  // hivemind_read MCP tool. The equivalent assertion against openclaw
  // lives in cases/08-openclaw-tools.ts.
  skipFor: ["openclaw"],
};

export default catIndexMdCase;
