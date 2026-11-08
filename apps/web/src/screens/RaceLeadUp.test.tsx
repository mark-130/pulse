import type { LeadUp } from "@pulse/shared";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadUpView } from "./RaceLeadUp";

const html = (node: React.ReactElement) => renderToString(node).replaceAll("<!-- -->", "");
const base: LeadUp = {
  raceKey: "k", title: "Rhino 10K", date: "2026-11-14", past: false, daysToGo: 7, priority: "B", prioritySet: false,
  weeks: [
    { weekStart: "2026-11-02", weekEnd: "2026-11-08", weeksBefore: 1, shownUntil: null, scheduledCount: 3, scheduledMinutes: 200, longest: { date: "2026-11-08", name: "1h50 Long Run", minutes: 110 }, restDays: 3, scheduledSoFar: 2, completedSoFar: 1, sessions: [{ date: "2026-11-08", name: "1h50 Long Run", minutes: 110, completed: false }] },
    { weekStart: "2026-11-09", weekEnd: "2026-11-15", weeksBefore: 0, shownUntil: null, scheduledCount: 0, scheduledMinutes: 0, longest: null, restDays: 7, scheduledSoFar: null, completedSoFar: null, sessions: [] },
  ],
  raceDayWorkouts: [], nearbyRaces: [],
  flags: [{ kind: "priority_not_set", text: "Priority not set." }, { kind: "race_day_workout", text: "A workout is scheduled in Garmin on race day: Shakeout, 20 min." }],
  clashes: [{ id: "c", kind: "long_run", severity: "info", message: "A 110 minute session is scheduled on 08/11, 6 days before Rhino 10K." }],
};

describe("race lead-up view", () => {
  it("shows days to go and what Garmin holds for each week, as counts", () => {
    const h = html(<LeadUpView leadUp={base} />);
    expect(h).toContain("7");
    expect(h).toContain("days to go");
    expect(h).toContain("Week of 02/11");
    expect(h).toContain("1 week before");
    expect(h).toContain("3 workouts scheduled, 200 min in total.");
    expect(h).toContain("Longest: 1h50 Long Run, 110 min");
    expect(h).toContain("3 rest days");
    expect(h).toContain("1 of 2 scheduled so far completed.");
    expect(h).toContain("Race week");
    expect(h).toContain("Nothing scheduled in Garmin.");
    expect(h).toContain("Scheduled sessions (1)");
  });
  it("shows the factual flags and clash warnings", () => {
    const h = html(<LeadUpView leadUp={base} />);
    expect(h).toContain("Priority not set.");
    expect(h).toContain("A workout is scheduled in Garmin on race day");
    expect(h).toContain("6 days before Rhino 10K");
  });
  it("offers no suggestion, target or advice", () => {
    expect(html(<LeadUpView leadUp={base} />)).not.toMatch(/suggest|target|taper|recommend|should|advice|focus/i);
  });
  it("a race with no weeks in Garmin yet says so, and a past race says it has happened", () => {
    expect(html(<LeadUpView leadUp={{ ...base, weeks: [], daysToGo: 120 }} />)).toContain("not in Garmin yet");
    expect(html(<LeadUpView leadUp={{ ...base, weeks: [], past: true, daysToGo: -3 }} />)).toContain("This race has happened.");
  });
  it("has no AI part at all", () => {
    expect(html(<LeadUpView leadUp={base} />)).not.toMatch(/AI|Sparkle/);
  });
});
