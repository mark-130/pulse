import { describe, expect, it } from "vitest";
import { changeText, priorityLabel, sevenDayRow } from "./races";

describe("seven day row", () => {
  it("outlines today and fills race day, with no tint for any lead-up days", () => {
    expect(sevenDayRow("2026-11-08", { date: "2026-11-14" })).toEqual(["today", "plain", "plain", "plain", "plain", "plain", "race"]);
  });
  it("keeps today outlined on race day's week and shows race day when it is in view", () => {
    expect(sevenDayRow("2026-11-12", { date: "2026-11-14" })).toEqual(["today", "plain", "race", "plain", "plain", "plain", "plain"]);
  });
  it("shows no race when there is none", () => {
    expect(sevenDayRow("2026-11-08", null)).toEqual(["today", "plain", "plain", "plain", "plain", "plain", "plain"]);
  });
  it("marks race day beyond a week as absent", () => {
    expect(sevenDayRow("2026-11-08", { date: "2026-12-20" })).not.toContain("race");
  });
});

describe("labels", () => {
  it("marks suggested values", () => {
    expect(priorityLabel({ priority: "B", priorityInferred: true })).toBe("B, suggested");
    expect(priorityLabel({ priority: "A", priorityInferred: false })).toBe("A");
    expect(changeText("Race", { priority: "A", type: null })).toBe("Race: priority A saved.");
    expect(changeText("Race", { priority: null, type: null })).toBe("Race: reset to the suggested values.");
  });
});
