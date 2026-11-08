import type { LeadUpWeek } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { longestLine, progressLine, scheduledLine, weekLabel, weekTitle } from "./leadup";

const week = (o: Partial<LeadUpWeek> = {}): LeadUpWeek => ({ weekStart: "2026-11-02", weekEnd: "2026-11-08", weeksBefore: 1, shownUntil: null, scheduledCount: 3, scheduledMinutes: 200, longest: { date: "2026-11-08", name: "1h50 Long Run", minutes: 110 }, restDays: 3, scheduledSoFar: 2, completedSoFar: 1, sessions: [], ...o });

describe("lead-up wording", () => {
  it("titles and labels a week", () => {
    expect(weekTitle(week())).toBe("Week of 02/11");
    expect(weekLabel(week())).toBe("1 week before");
    expect(weekLabel(week({ weeksBefore: 3 }))).toBe("3 weeks before");
    expect(weekLabel(week({ weeksBefore: 0 }))).toBe("Race week");
  });
  it("counts what is scheduled, with no judgement", () => {
    expect(scheduledLine(week())).toBe("3 workouts scheduled, 200 min in total.");
    expect(scheduledLine(week({ scheduledCount: 0, scheduledMinutes: 0 }))).toBe("Nothing scheduled in Garmin.");
    expect(longestLine(week())).toBe("Longest: 1h50 Long Run, 110 min, Sun 08/11/2026.");
    expect(longestLine(week({ longest: null }))).toBeNull();
  });
  it("says completed against scheduled so far, only for a week that has started", () => {
    expect(progressLine(week())).toBe("1 of 2 scheduled so far completed.");
    expect(progressLine(week({ scheduledSoFar: null, completedSoFar: null }))).toBeNull();
  });
});
