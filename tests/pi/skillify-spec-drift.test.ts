/**
 * Drift detection for pi's mirror of SKILLIFY_COMMANDS.
 *
 * pi's extension ships as a single self-contained .ts file loaded by pi's
 * runtime, so it can't import the canonical spec from src/cli/. Instead
 * it keeps a hand-maintained mirror called PI_SKILLIFY_COMMANDS. This test
 * fails the build if the two lists fall out of sync — adding a new
 * subcommand to the spec without updating pi is the most likely way they
 * drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLIFY_COMMANDS } from "../../src/cli/skillify-spec.js";

const PI_SOURCE = readFileSync(
  join(process.cwd(), "pi", "extension-source", "hivemind.ts"),
  "utf-8",
);

// Isolate the PI_SKILLIFY_COMMANDS array literal so we don't accidentally
// count `cmd:` occurrences from elsewhere in the file.
const piArrayMatch = PI_SOURCE.match(
  /const PI_SKILLIFY_COMMANDS[^]*?\];/,
);

describe("pi skillify spec drift", () => {
  it("pi mirror block is present", () => {
    expect(piArrayMatch, "PI_SKILLIFY_COMMANDS array literal not found in pi/extension-source/hivemind.ts").toBeTruthy();
  });

  it("pi mirror has the same number of entries as the canonical spec", () => {
    const piBlock = piArrayMatch![0];
    // Count only entry rows (`cmd: "..."`), not the TS type annotation
    // (`cmd: string;`) that appears at the top of the array declaration.
    const piEntryCount = (piBlock.match(/cmd:\s*"/g) ?? []).length;
    expect(
      piEntryCount,
      `pi has ${piEntryCount} entries but src/cli/skillify-spec.ts has ${SKILLIFY_COMMANDS.length}; sync them`,
    ).toBe(SKILLIFY_COMMANDS.length);
  });

  for (const c of SKILLIFY_COMMANDS) {
    it(`pi mirror contains command "${c.cmd}"`, () => {
      expect(piArrayMatch![0]).toContain(c.cmd);
    });
    it(`pi mirror contains description for "${c.cmd}"`, () => {
      expect(piArrayMatch![0]).toContain(c.desc);
    });
  }
});
