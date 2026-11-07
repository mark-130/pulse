import { describe, expect, it } from "vitest";
import { todayResponseSchema, trendsResponseSchema, weekResponseSchema, syncStatusSchema, racesResponseSchema } from "@pulse/shared";
import { TODAY } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const clock = () => new Date(`${TODAY}T12:30:00Z`);

describe("garmin read routes", () => {
  it("require a session", async () => {
    const { app } = await makeGarminApp({ clock });
    for (const p of ["/api/today", "/api/week", "/api/trends", "/api/races", "/api/sync/status"]) expect((await req(app, p)).status).toBe(401);
  });

  it("serve empty states before the first sync", async () => {
    const t = await makeGarminApp({ clock });
    const today = todayResponseSchema.parse(await (await t.get("/api/today")).json());
    expect(today).toMatchObject({ date: TODAY, syncedAt: null, readiness: null, nextRace: null });
    const status = syncStatusSchema.parse(await (await t.get("/api/sync/status")).json());
    expect(status.garmin).toMatchObject({ lastOk: null, stale: true });
    expect(t.fake.calls).toHaveLength(0);
  });

  it("serve synced data from the database without calling Garmin", async () => {
    const t = await makeGarminApp({ clock });
    expect((await t.post("/api/sync/garmin")).status).toBe(200);
    const callsAfterSync = t.fake.calls.length;

    const today = todayResponseSchema.parse(await (await t.get("/api/today")).json());
    expect(today.syncedAt).not.toBeNull();
    expect(today.readiness).toMatchObject({ score: 63, level: "MODERATE", sleepScore: 89 });
    expect(today.session.today).toEqual([]);
    expect(today.session.next).toMatchObject({ name: "1h50 Long Run", date: "2026-11-08", durationS: 6600 });
    expect(today.session.activitiesToday).toHaveLength(1);
    expect(today.metrics.hrv).toMatchObject({ lastNightAvg: 45, baselineLow: 36, baselineUpper: 41 });
    expect(today.metrics.restingHr).toMatchObject({ bpm: 45, sevenDayAvg: 47 });
    expect(today.metrics.bodyBattery).toMatchObject({ current: 61, highest: 100 });
    expect(today.nextRace).toMatchObject({ title: "Rhino Run West Bridgford", daysUntil: 7, startTimeLocal: "09:00", timeZone: "Europe/London", goalTimeSeconds: 3000 });
    expect(today.followingRace?.title).toBe("Pierrepont Plod Spring 27");

    const week = weekResponseSchema.parse(await (await t.get("/api/week")).json());
    expect(week.start).toBe("2026-11-02");
    expect(week.end).toBe("2026-11-08");
    const sunday = week.days.find((d) => d.date === "2026-11-08");
    expect(sunday?.workouts[0]?.name).toBe("1h50 Long Run");
    expect(week.totals.runs).toBe(2);
    expect(week.totals.distanceM).toBeCloseTo(7864.2 + 9000, 0);

    const trends = trendsResponseSchema.parse(await (await t.get("/api/trends")).json());
    expect(trends.trainingLoad).toHaveLength(2);
    expect(trends.weeklyDistance).toHaveLength(12);
    expect(trends.racePredictions?.items.map((i) => i.label)).toEqual(["5K", "10K", "Half marathon", "Marathon"]);

    const races = racesResponseSchema.parse(await (await t.get("/api/races")).json());
    expect(races.races).toHaveLength(5);

    expect(t.fake.calls.length).toBe(callsAfterSync);
  });

  it("week accepts a start date and rejects junk", async () => {
    const t = await makeGarminApp({ clock });
    const w = weekResponseSchema.parse(await (await t.get("/api/week?start=2026-10-28")).json());
    expect(w.start).toBe("2026-10-26");
    expect((await t.get("/api/week?start=nope")).status).toBe(400);
  });

  it("manual sync needs CSRF, is rate limited and reports a stale status", async () => {
    const t = await makeGarminApp({ clock });
    expect((await req(t.app, "/api/sync/garmin", { method: "POST", headers: { cookie: t.cookie } })).status).toBe(403);
    expect((await t.post("/api/sync/garmin")).status).toBe(200);
    expect((await t.post("/api/sync/garmin")).status).toBe(429);
    const fresh = syncStatusSchema.parse(await (await t.get("/api/sync/status")).json());
    expect(fresh.garmin.stale).toBe(false);
    expect(fresh.backup.lastOk).toBeNull();
  });

  it("reports stale data once the last sync is older than 90 minutes", async () => {
    let now = new Date(`${TODAY}T12:30:00Z`);
    const t = await makeGarminApp({ clock: () => now });
    await t.post("/api/sync/garmin");
    now = new Date(`${TODAY}T13:50:00Z`);
    expect(syncStatusSchema.parse(await (await t.get("/api/sync/status")).json()).garmin.stale).toBe(false);
    now = new Date(`${TODAY}T14:10:00Z`);
    const s = syncStatusSchema.parse(await (await t.get("/api/sync/status")).json());
    expect(s.garmin).toMatchObject({ stale: true, ageMinutes: 100 });
  });

  it("a failed sync keeps the old data and shows the error without secrets", async () => {
    const t = await makeGarminApp({ clock, fake: { fail: { get_calendar_events: "down http://garmin-mcp:8000/mcp?token=abc" } } });
    expect((await t.post("/api/sync/garmin")).status).toBe(200);
    const s = syncStatusSchema.parse(await (await t.get("/api/sync/status")).json());
    expect(s.garmin.consecutiveFailures).toBe(1);
    expect(s.garmin.lastError).toContain("calendar_events");
    expect(s.garmin.lastError).not.toContain("abc");
    expect(s.garmin.lastError).not.toContain("garmin-mcp");
  });
});
