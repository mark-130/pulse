import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { activity, garminSnapshot, race, syncState, workout } from "../src/db/schema.js";
import { runGarminSync } from "../src/modules/garmin/sync.js";
import { calendarEvents, fakeGarmin, payloads, TODAY } from "./fixtures.js";

let dir: string;
let handle: ReturnType<typeof openDb>;
const now = () => new Date(`${TODAY}T12:30:00Z`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-sync-"));
  handle = openDb(dir);
});
afterEach(() => {
  handle.sqlite.close();
  rmSync(dir, { recursive: true });
});

describe("garmin sync", () => {
  it("stores races with every field, keyed by uuid or date plus title", async () => {
    const fake = fakeGarmin();
    const res = await runGarminSync({ db: handle.db, connect: fake.connect, now });
    expect(res.ok).toBe(true);
    const rows = handle.db.select().from(race).all();
    expect(rows).toHaveLength(calendarEvents.length);
    const rhino = rows.find((r) => r.title.startsWith("Rhino"));
    expect(rhino).toMatchObject({ eventKey: "2026-11-14|rhino run west bridgford", eventUuid: null, date: "2026-11-14", startTimeLocal: "09:00", timeZone: "Europe/London", distanceM: 10000, goalTimeSeconds: 3000, isRace: true, primaryEvent: false, subscribed: false, location: null, url: null, active: true });
    const antwerp = rows.find((r) => r.title.includes("Antwerp"));
    expect(antwerp).toMatchObject({ eventKey: "b0c242ba-8350-4eeb-8185-e9b02f156cb4", startTimeLocal: "01:30", timeZone: "Europe/Paris" });
    expect(rows.find((r) => r.title.startsWith("Pierrepont"))?.isRace).toBe(false);
  });

  it("is idempotent, keeps first_seen and marks races Garmin stops returning as inactive", async () => {
    await runGarminSync({ db: handle.db, connect: fakeGarmin().connect, now });
    const before = handle.db.select().from(race).where(eq(race.eventKey, "2026-11-14|rhino run west bridgford")).get();
    const later = () => new Date("2026-11-07T13:30:00Z");
    const fewer = { count: 4, events: calendarEvents.filter((e) => !e.title.startsWith("Rhino")) };
    await runGarminSync({ db: handle.db, connect: fakeGarmin({ overrides: { get_calendar_events: fewer } }).connect, now: later });
    const rows = handle.db.select().from(race).all();
    expect(rows).toHaveLength(calendarEvents.length);
    const rhino = rows.find((r) => r.title.startsWith("Rhino"));
    expect(rhino?.active).toBe(false);
    expect(rhino?.firstSeen).toBe(before?.firstSeen);
    expect(rows.filter((r) => r.active)).toHaveLength(4);
  });

  it("stores workouts and activities, snapshots raw payloads once per day", async () => {
    await runGarminSync({ db: handle.db, connect: fakeGarmin().connect, now });
    await runGarminSync({ db: handle.db, connect: fakeGarmin().connect, now });
    expect(handle.db.select().from(workout).all()).toMatchObject([{ garminScheduledId: "1833019748", date: "2026-11-08", name: "1h50 Long Run", durationS: 6600, completed: false }]);
    expect(handle.db.select().from(activity).all()).toHaveLength(3);
    const snaps = handle.db.select().from(garminSnapshot).all();
    expect(snaps.filter((s) => s.kind === "scheduled_workouts")).toHaveLength(1);
    expect(snaps.map((s) => s.kind)).toEqual(expect.arrayContaining(["calendar_events", "training_readiness", "sleep", "hrv", "stats", "race_predictions"]));
  });

  it("drops a future workout Garmin no longer returns but keeps past ones", async () => {
    await runGarminSync({ db: handle.db, connect: fakeGarmin().connect, now });
    handle.db.insert(workout).values({ garminScheduledId: "old", date: "2026-11-02", name: "Past", durationS: 1, completed: true, firstSeen: "x", lastSeen: "x" }).run();
    await runGarminSync({ db: handle.db, connect: fakeGarmin({ overrides: { get_scheduled_workouts: { scheduled_workouts: [] } } }).connect, now });
    expect(handle.db.select().from(workout).all().map((w) => w.garminScheduledId)).toEqual(["old"]);
  });

  it("treats a no data message as empty, not as a failure", async () => {
    const res = await runGarminSync({ db: handle.db, connect: fakeGarmin({ empty: ["get_sleep_summary"] }).connect, now });
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.name === "sleep")?.status).toBe("empty");
  });

  it("treats a plain text upstream error as a failure, not as empty", async () => {
    const msg = "Error retrieving training load data for 2026-10-12: Garmin Connect request failed: Read timed out (token=abc)";
    const res = await runGarminSync({ db: handle.db, connect: fakeGarmin({ messages: { get_training_load_trend: msg } }).connect, now, sleep: async () => undefined });
    const t = res.tasks.find((x) => x.name === "training_load_trend");
    expect(t?.status).toBe("failed");
    expect(t?.error).not.toContain("abc");
    expect(res.ok).toBe(true);
  });

  it("survives an optional failure but fails when an essential call fails", async () => {
    const optional = await runGarminSync({ db: handle.db, connect: fakeGarmin({ fail: { get_hrv_data: "boom" } }).connect, now });
    expect(optional.ok).toBe(true);
    expect(optional.tasks.find((t) => t.name === "hrv")).toMatchObject({ status: "failed", error: "boom" });
    const essential = await runGarminSync({ db: handle.db, connect: fakeGarmin({ fail: { get_calendar_events: "down" } }).connect, now });
    expect(essential).toMatchObject({ ok: true, partial: true });
    const dead = await runGarminSync({ db: handle.db, connect: fakeGarmin({ fail: Object.fromEntries(Object.keys(payloads).map((k) => [k, "down"])) }).connect, now });
    expect(dead).toMatchObject({ ok: false, partial: false });
  });

  it("a failed activities call does not discard or block the other kinds", async () => {
    const res = await runGarminSync({ db: handle.db, connect: fakeGarmin({ fail: { get_activities_by_date: "boom" } }).connect, now });
    expect(res).toMatchObject({ ok: true, partial: true });
    const kinds = handle.db.select().from(garminSnapshot).all().map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["scheduled_workouts", "training_readiness", "sleep", "hrv", "training_load_trend"]));
    expect(handle.db.select().from(workout).all()).toHaveLength(1);
    const rows = Object.fromEntries(handle.db.select().from(syncState).all().map((r) => [r.job, r]));
    expect(rows["garmin:activities"]).toMatchObject({ lastOk: null, lastError: "boom", consecutiveFailures: 1 });
    expect(rows["garmin:sleep"]).toMatchObject({ lastOk: now().toISOString(), lastError: null });
  });

  it("retries a timed out call and succeeds on the second attempt", async () => {
    const waits: number[] = [];
    let n = 0;
    const base = fakeGarmin();
    const connect: typeof base.connect = async () => {
      const s = await base.connect();
      return {
        close: () => s.close(),
        call: async (tool, args) => {
          if (tool === "get_activities_by_date" && n++ === 0) throw new Error("Read timed out. (read timeout=15)");
          return s.call(tool, args);
        },
      };
    };
    const res = await runGarminSync({ db: handle.db, connect, now, sleep: async (ms) => void waits.push(ms) });
    expect(res.tasks.find((t) => t.name === "activities")?.status).toBe("ok");
    expect(res.partial).toBe(false);
    expect(waits).toEqual([10_000]);
    expect(handle.db.select().from(activity).all().length).toBeGreaterThan(0);
  });

  it("gives up after two retries with waits of 10 and 30 seconds, then counts the failure", async () => {
    const waits: number[] = [];
    const fake = fakeGarmin({ messages: { get_sleep_summary: "Error retrieving sleep: Read timed out" } });
    const res = await runGarminSync({ db: handle.db, connect: fake.connect, now, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([10_000, 30_000]);
    expect(fake.calls.filter((c) => c.tool === "get_sleep_summary")).toHaveLength(3);
    expect(res.tasks.find((t) => t.name === "sleep")?.status).toBe("failed");
  });

  it("does not retry errors that are not timeouts", async () => {
    const waits: number[] = [];
    const fake = fakeGarmin({ fail: { get_hrv_data: "bad request" } });
    await runGarminSync({ db: handle.db, connect: fake.connect, now, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([]);
    expect(fake.calls.filter((c) => c.tool === "get_hrv_data")).toHaveLength(1);
  });

  it("reports an unexpected payload shape as a failure without storing it", async () => {
    const res = await runGarminSync({ db: handle.db, connect: fakeGarmin({ overrides: { get_calendar_events: { events: [{ nope: 1 }] } } }).connect, now });
    expect(res.tasks.find((t) => t.name === "calendar_events")?.status).toBe("failed");
    expect(handle.db.select().from(race).all()).toHaveLength(0);
  });

  it("only ever calls tools on the read allowlist, with a backfill on the first run", async () => {
    const fake = fakeGarmin();
    await runGarminSync({ db: handle.db, connect: fake.connect, now });
    const act = fake.calls.find((c) => c.tool === "get_activities_by_date");
    expect(act?.args.start_date).toBe("2026-05-11");
    const second = fakeGarmin();
    await runGarminSync({ db: handle.db, connect: second.connect, now });
    expect(second.calls.find((c) => c.tool === "get_activities_by_date")?.args.start_date).toBe("2026-10-24");
  });
});
