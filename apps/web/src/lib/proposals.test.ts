import { describe, expect, it } from "vitest";
import { diffRows, isDestructive, kindTitle, statusLabel, verificationLabel } from "./proposals";

const before = { scheduledId: "1", name: "Long Run", date: "2026-11-08", durationS: 6600, completed: false };

describe("proposal wording", () => {
  it("shows the exact before and after for a move", () => {
    const rows = diffRows({ kind: "garmin.reschedule", before, after: { ...before, date: "2026-11-10" } });
    expect(rows.find((r) => r.label === "Date")).toEqual({ label: "Date", before: "Sun 08/11/2026", after: "Tue 10/11/2026" });
    expect(rows.find((r) => r.label === "Workout")).toMatchObject({ before: "Long Run", after: "Long Run" });
  });
  it("says the workout stays in the library when it is removed", () => {
    const rows = diffRows({ kind: "garmin.unschedule", before, after: null });
    expect(rows[1]?.after).toContain("stays in your Garmin library");
  });
  it("marks only the removal as destructive", () => {
    expect(isDestructive("garmin.unschedule")).toBe(true);
    expect(isDestructive("garmin.reschedule")).toBe(false);
    expect(kindTitle("garmin.reschedule")).toBe("Move workout");
  });
  it("labels statuses and the conflict probe result", () => {
    expect(statusLabel({ status: "applied", result: { mode: "dry_run" } })).toBe("Applied as a dry run");
    expect(statusLabel({ status: "applied", result: { mode: "live" } })).toBe("Applied");
    expect(statusLabel({ status: "stale", result: null })).toBe("Out of date");
    expect(verificationLabel({ state: "verified", matches: 2, checks: [] })).toBe("Verified");
    expect(verificationLabel({ state: "reverted", matches: 0, checks: [] })).toBe("Reverted by the plan app");
    expect(verificationLabel({ state: "waiting", matches: 3, checks: [], lastConfirmedAt: "2026-11-08T07:30:00Z" })).toBe("Checking, last confirmed 07:30 08/11");
    expect(verificationLabel({ state: "waiting", matches: 0, checks: [], lastConfirmedAt: null })).toBe("Checking, not confirmed by a sync yet");
    expect(verificationLabel(undefined)).toBeNull();
  });
});
