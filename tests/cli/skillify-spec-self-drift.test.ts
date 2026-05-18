/**
 * Self-drift detection: `SKILLIFY_SPEC` (hierarchical, used by the CLI help
 * renderers) and `SKILLIFY_COMMANDS` (flat, used by SessionStart inject
 * blocks and the pi mirror) must agree on every (subcommand + option)
 * combination.
 *
 * If a developer adds a new subcommand or flag to one view but forgets the
 * other, the per-view consumers (CLI help vs. SessionStart inject) start
 * showing different surfaces — exactly the drift problem this whole module
 * exists to prevent.
 *
 * The contract:
 *   - Every flat entry in SKILLIFY_COMMANDS whose `cmd` starts with a
 *     SKILLIFY_SPEC subcommand prefix must correspond to either:
 *       (a) the subcommand's base entry (matches `sub.cmd` exactly, or
 *           `sub.cmd <args>` when `args` is set), OR
 *       (b) one of `sub.options[*].flag` appended after `sub.cmd`.
 *   - Every (sub, option) pair in SKILLIFY_SPEC must appear in SKILLIFY_COMMANDS
 *     as `${sub.cmd} ${option.flag}` with the same `desc`.
 */

import { describe, it, expect } from "vitest";
import {
  SKILLIFY_COMMANDS,
  SKILLIFY_SPEC,
} from "../../src/cli/skillify-spec.js";

describe("skillify-spec self-drift", () => {
  it("every SKILLIFY_SPEC base subcommand has a matching flat entry", () => {
    for (const sub of SKILLIFY_SPEC) {
      const expectedCmd = sub.args ? `${sub.cmd} ${sub.args}` : sub.cmd;
      const match = SKILLIFY_COMMANDS.find(c => c.cmd === expectedCmd);
      expect(match, `flat entry missing for "${expectedCmd}"`).toBeTruthy();
      expect(match!.desc, `desc mismatch for "${expectedCmd}"`).toBe(sub.desc);
    }
  });

  it("every SKILLIFY_SPEC option has a matching flat entry", () => {
    for (const sub of SKILLIFY_SPEC) {
      if (!sub.options) continue;
      for (const opt of sub.options) {
        const expectedCmd = `${sub.cmd} ${opt.flag}`;
        const match = SKILLIFY_COMMANDS.find(c => c.cmd === expectedCmd);
        expect(match, `flat entry missing for "${expectedCmd}"`).toBeTruthy();
        expect(match!.desc, `desc mismatch for "${expectedCmd}"`).toBe(opt.desc);
      }
    }
  });

  it("every SKILLIFY_COMMANDS entry maps back to SKILLIFY_SPEC", () => {
    const subCmds = SKILLIFY_SPEC.map(s => s.cmd).sort((a, b) => b.length - a.length);
    for (const c of SKILLIFY_COMMANDS) {
      // Find the longest matching subcommand prefix.
      const sub = subCmds.find(sc => c.cmd === sc || c.cmd.startsWith(sc + " "));
      expect(sub, `flat entry "${c.cmd}" has no matching SKILLIFY_SPEC subcommand`).toBeTruthy();
    }
  });
});
