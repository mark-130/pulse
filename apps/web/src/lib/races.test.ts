import { describe, expect, it } from "vitest";
import { changeText, priorityLabel, sevenDayRow } from "./races";

const taper = (start: string | null) => ({ days: 4, start, status: "", advice: null });

describe("seven day row", () => {
  it("outlines today, tints taper days and fills race day", () => {
    expect(sevenDayRow("2026-11-08", { date: "2026-11-14", taper: taper("2026-11-10") })).toEqual(["today", "plain", "taper", "taper", "taper", "taper", "race"]);
  });
  it("keeps today outlined when it is already in the taper", () => {
    expect(sevenDayRow("2026-11-12", { date: "2026-11-14", taper: taper("2026-11-10") })).toEqual(["today", "taper", "race", "plain", "plain", "plain", "plain"]);
  });
  it("shows no taper tint for a C race or when there is no race", () => {
    expect(sevenDayRow("2026-11-08", { date: "2026-11-10", taper: taper(null) })).toEqual(["today", "plain", "race", "plain", "plain", "plain", "plain"]);
    expect(sevenDayRow("2026-11-08", null)).toEqual(["today", "plain", "plain", "plain", "plain", "plain", "plain"]);
  });
  it("marks race day beyond a week as absent", () => {
    expect(sevenDayRow("2026-11-08", { date: "2026-12-20", taper: taper("2026-12-10") })).not.toContain("race");
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
