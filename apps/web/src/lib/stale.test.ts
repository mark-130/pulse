import type { GroupStatus, SyncStatus } from "@pulse/shared";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bannerFor, kindNote } from "./stale";

const job = { lastOk: null, lastAttempt: null, lastError: null, consecutiveFailures: 0, detail: null, ageMinutes: null, stale: true };
const grp = (id: GroupStatus["id"], label: string, plural: boolean, critical: boolean, o: Partial<GroupStatus> = {}): GroupStatus => ({
  id, label, plural, critical, lastOk: "2026-11-07T11:50:00Z", ageMinutes: 10, stale: false, lastError: null, ...o,
});
const groups = (o: Partial<Record<GroupStatus["id"], Partial<GroupStatus>>> = {}): GroupStatus[] => [
  grp("plan", "the plan", false, true, o.plan),
  grp("readiness", "readiness", false, true, o.readiness),
  grp("activities", "activities", true, false, o.activities),
  grp("trends", "trends", true, false, o.trends),
];
const status = (garmin: Partial<SyncStatus["garmin"]>, g: GroupStatus[] = []): SyncStatus => ({
  now: "2026-11-07T12:00:00Z", staleAfterMinutes: 90, garmin: { ...job, ...garmin }, groups: g, backup: job,
});
const fresh = { lastOk: "2026-11-07T11:50:00Z", ageMinutes: 10, stale: false };
const LONG = "Garmin tool error: " + "Error retrieving activities: HTTPSConnectionPool(host=[url], port=443): Read timed out. (read timeout=15)".repeat(20);

describe("stale banner", () => {
  it("is hidden when data is fresh", () => {
    expect(bannerFor(status(fresh, groups()), true)).toBeNull();
    expect(bannerFor(undefined, true)).toBeNull();
  });
  it("says Garmin has not synced yet when there is no successful sync", () => {
    expect(bannerFor(status({}), true)).toMatchObject({ tone: "stale", text: "Garmin has not synced yet." });
  });
  it("stays hidden when only activities are behind, and leaves a quiet note instead", () => {
    const s = status(fresh, groups({ activities: { stale: true, ageMinutes: 95, lastOk: "2026-11-07T10:25:00Z", lastError: "Read timed out" } }));
    expect(bannerFor(s, true)).toBeNull();
    expect(kindNote(s, "activities")).toBe("Activities are 95 minutes old. Retrying automatically.");
    expect(kindNote(s, "trends")).toBeNull();
    expect(kindNote(s, "plan")).toBeNull();
  });
  it("names the critical kind that is behind and says what is current", () => {
    const s = status(
      { lastOk: "2026-11-07T10:25:00Z", ageMinutes: 95, stale: true },
      groups({ readiness: { stale: true, ageMinutes: 95, lastOk: "2026-11-07T10:25:00Z", lastError: "Read timed out" } }),
    );
    const b = bannerFor(s, true);
    expect(b?.text).toBe("Readiness is 95 minutes old. The plan, activities and trends are current.");
    expect(b?.headline).toBe("Garmin Connect timed out. Retrying automatically.");
    expect(b?.synced).toBe("Last synced 07/11/2026 10:25.");
  });
  it("falls back to a simple age line for a database without per-kind rows", () => {
    const b = bannerFor(status({ lastOk: "2026-11-07T09:30:00Z", ageMinutes: 150, stale: true }), true);
    expect(b?.text).toBe("Garmin data is 3 hours old.");
    expect(b?.synced).toBe("Last synced 07/11/2026 09:30.");
  });
  it("prefers the offline message and still gives the last sync", () => {
    const b = bannerFor(status({ lastOk: "2026-11-07T09:30:00Z", ageMinutes: 5, stale: false }), false);
    expect(b).toMatchObject({ tone: "offline" });
    expect(b?.synced).toContain("07/11/2026 09:30");
  });
  it("keeps a very long raw error out of the visible message and inside Details", () => {
    const s = status(
      { lastOk: "2026-11-07T10:25:00Z", ageMinutes: 95, stale: true, lastError: LONG },
      groups({ plan: { stale: true, ageMinutes: 95, lastOk: "2026-11-07T10:25:00Z", lastError: LONG } }),
    );
    const b = bannerFor(s, true);
    expect(b?.detail).toBe(LONG);
    expect(LONG.length).toBeGreaterThan(1500);
    for (const visible of [b?.headline, b?.text, b?.synced]) expect((visible ?? "").length).toBeLessThan(140);
  });
});

describe("stale banner layout", () => {
  const src = readFileSync(new URL("../components/StaleBanner.tsx", import.meta.url), "utf8");
  it("wraps long text, keeps the raw error in a monospace block, and stacks a full width Sync now button", () => {
    expect(src).toContain("[overflow-wrap:anywhere]");
    expect(src).toMatch(/<details/);
    expect(src).toMatch(/<pre[^>]*font-mono/);
    expect(src).toMatch(/Button[^>]*w-full/);
    expect(src).toContain('"Syncing"');
    expect(src).toContain("Copy");
  });
});
