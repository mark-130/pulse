import type { SyncStatus } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { bannerFor } from "./stale";

const job = { lastOk: null, lastAttempt: null, lastError: null, consecutiveFailures: 0, detail: null, ageMinutes: null, stale: true };
const status = (garmin: Partial<SyncStatus["garmin"]>): SyncStatus => ({ now: "2026-11-07T12:00:00Z", staleAfterMinutes: 90, garmin: { ...job, ...garmin }, backup: job });

describe("stale banner", () => {
  it("is hidden when data is fresh", () => {
    expect(bannerFor(status({ lastOk: "2026-11-07T11:50:00Z", ageMinutes: 10, stale: false }), true)).toBeNull();
    expect(bannerFor(undefined, true)).toBeNull();
  });
  it("says Garmin has not synced yet when there is no successful sync", () => {
    expect(bannerFor(status({}), true)).toMatchObject({ tone: "stale", text: "Garmin has not synced yet." });
  });
  it("states the age and the last sync in UK format", () => {
    const b = bannerFor(status({ lastOk: "2026-11-07T09:30:00Z", ageMinutes: 150, stale: true, lastError: "down" }), true);
    expect(b?.text).toBe("Garmin data is 3 hours old. Last synced 07/11/2026 09:30.");
    expect(b?.detail).toBe("down");
  });
  it("prefers the offline message and still gives the last sync", () => {
    const b = bannerFor(status({ lastOk: "2026-11-07T09:30:00Z", ageMinutes: 5, stale: false }), false);
    expect(b).toMatchObject({ tone: "offline" });
    expect(b?.text).toContain("Last synced 07/11/2026 09:30.");
  });
});
