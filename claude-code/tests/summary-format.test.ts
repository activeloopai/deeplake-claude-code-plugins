import { describe, expect, it } from "vitest";
import {
  buildSummaryBlurb,
  buildSummaryIndexLine,
  extractHeaderField,
  extractSection,
  extractSummaryDate,
  extractSummaryParticipants,
  extractSummarySource,
  extractSummaryTopics,
} from "../../src/utils/summary-format.js";

const SUMMARY = `# Session conv_0_session_10
- **Source**: /sessions/conv_0_session_10.json
- **Date**: 8:56 pm on 20 July, 2023
- **Participants**: Caroline, Melanie
- **Project**: locomo
- **Topics**: LGBTQ activism, family summer traditions

## What Happened
Caroline and Melanie talked about activism, family trips, and a recent child milestone.

## Searchable Facts
- Caroline joined Connected LGBTQ Activists last Tuesday.
- Melanie's family takes an annual summer camping trip.
- Melanie's youngest child recently took her first steps.
`;

describe("summary-format", () => {
  it("extracts header fields and sections", () => {
    expect(extractHeaderField(SUMMARY, "Source")).toBe("/sessions/conv_0_session_10.json");
    expect(extractSection(SUMMARY, "What Happened")).toContain("activism");
  });

  it("extracts common summary metadata", () => {
    expect(extractSummaryDate(SUMMARY)).toBe("8:56 pm on 20 July, 2023");
    expect(extractSummaryParticipants(SUMMARY)).toBe("Caroline, Melanie");
    expect(extractSummaryTopics(SUMMARY)).toBe("LGBTQ activism, family summer traditions");
    expect(extractSummarySource(SUMMARY)).toBe("/sessions/conv_0_session_10.json");
  });

  it("builds a searchable blurb from participants, topics, and facts", () => {
    const blurb = buildSummaryBlurb(SUMMARY);
    expect(blurb).toContain("Caroline, Melanie");
    expect(blurb).toContain("Connected LGBTQ Activists");
    expect(blurb).not.toContain("## Searchable Facts");
  });

  it("builds an index line with source and metadata", () => {
    const line = buildSummaryIndexLine({
      path: "/summaries/locomo/conv_0_session_10_summary.md",
      project: "locomo",
      description: "fallback description",
      summary: SUMMARY,
      creation_date: "2026-04-18T00:00:00.000Z",
      last_update_date: "2026-04-18T13:45:00.000Z",
    });

    expect(line).toContain("conv_0_session_10_summary.md");
    expect(line).toContain("8:56 pm on 20 July, 2023");
    expect(line).toContain("Caroline, Melanie");
    expect(line).toContain("[session](/sessions/conv_0_session_10.json)");
    expect(line).toContain("updated: 2026-04-18 13:45 UTC");
  });

  it("returns null for rows without a path", () => {
    expect(buildSummaryIndexLine({})).toBeNull();
  });
});
