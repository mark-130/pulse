import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { activity, garminSnapshot, race, settings, syncState, workout } from "../src/db/schema.js";
import { GARMIN_READ_TOOLS, type GarminConnector, type GarminResult } from "../src/modules/garmin/client.js";
import { BACKFILL_PAUSE_MS, runGarminSync } from "../src/modules/garmin/sync.js";
import { calendarEvents, fakeGarmin, payloads, TODAY } from "./fixtures.js";

let dir: string;
let handle: ReturnType<typeof openDb>;
const now = () => new Date(`${TODAY}T12:30:00Z`);
/** Tests never wait for the real backfill pause or retry waits unless they pass their own sleep. */
/** Marks the 28 day readings backfill as finished, for tests about other calls. */
const skipReadings = () => handle.db.insert(settings).values({ key: "garmin_readings_backfill", value: { windows: [], empty: {} } }).run();
const run = (o: Parameters<typeof runGarminSync>[0]) => runGarminSync({ sleep: async () => undefined, ...o });

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
    const res = await run({ db: handle.db, connect: fake.connect, now });
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
    await run({ db: handle.db, connect: fakeGarmin().connect, now });
    const before = handle.db.select().from(race).where(eq(race.eventKey, "2026-11-14|rhino run west bridgford")).get();
    const later = () => new Date("2026-11-07T13:30:00Z");
    const fewer = { count: 4, events: calendarEvents.filter((e) => !e.title.startsWith("Rhino")) };
    await run({ db: handle.db, connect: fakeGarmin({ overrides: { get_calendar_events: fewer } }).connect, now: later });
    const rows = handle.db.select().from(race).all();
    expect(rows).toHaveLength(calendarEvents.length);
    const rhino = rows.find((r) => r.title.startsWith("Rhino"));
    expect(rhino?.active).toBe(false);
    expect(rhino?.firstSeen).toBe(before?.firstSeen);
    expect(rows.filter((r) => r.active)).toHaveLength(4);
  });

  it("stores workouts and activities, snapshots raw payloads once per day", async () => {
    await run({ db: handle.db, connect: fakeGarmin().connect, now });
    await run({ db: handle.db, connect: fakeGarmin().connect, now });
    expect(handle.db.select().from(workout).all()).toMatchObject([{ garminScheduledId: "1833019748", date: "2026-11-08", name: "1h50 Long Run", durationS: 6600, completed: false }]);
    expect(handle.db.select().from(activity).all()).toHaveLength(3);
    const snaps = handle.db.select().from(garminSnapshot).all();
    expect(snaps.filter((s) => s.kind === "scheduled_workouts")).toHaveLength(1);
    expect(snaps.map((s) => s.kind)).toEqual(expect.arrayContaining(["calendar_events", "training_readiness", "sleep", "hrv", "stats", "race_predictions"]));
  });

  it("drops a future workout Garmin no longer returns but keeps past ones", async () => {
    await run({ db: handle.db, connect: fakeGarmin().connect, now });
    handle.db.insert(workout).values({ garminScheduledId: "old", date: "2026-11-02", name: "Past", durationS: 1, completed: true, firstSeen: "x", lastSeen: "x" }).run();
    await run({ db: handle.db, connect: fakeGarmin({ overrides: { get_scheduled_workouts: { scheduled_workouts: [] } } }).connect, now });
    expect(handle.db.select().from(workout).all().map((w) => w.garminScheduledId)).toEqual(["old"]);
  });

  it("treats a no data message as empty, not as a failure", async () => {
    const res = await run({ db: handle.db, connect: fakeGarmin({ empty: ["get_sleep_summary"] }).connect, now });
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.name === "sleep")?.status).toBe("empty");
  });

  it("treats a plain text upstream error as a failure, not as empty", async () => {
    const msg = "Error retrieving training load data for 2026-10-12: Garmin Connect request failed: Read timed out (token=abc)";
    const res = await run({ db: handle.db, connect: fakeGarmin({ messages: { get_training_load_trend: msg } }).connect, now, sleep: async () => undefined });
    const t = res.tasks.find((x) => x.name === "training_load_trend");
    expect(t?.status).toBe("failed");
    expect(t?.error).not.toContain("abc");
    expect(res.ok).toBe(true);
  });

  it("survives an optional failure but fails when an essential call fails", async () => {
    const optional = await run({ db: handle.db, connect: fakeGarmin({ fail: { get_hrv_data: "boom" } }).connect, now });
    expect(optional.ok).toBe(true);
    expect(optional.tasks.find((t) => t.name === "hrv")).toMatchObject({ status: "failed", error: "boom" });
    const essential = await run({ db: handle.db, connect: fakeGarmin({ fail: { get_calendar_events: "down" } }).connect, now });
    expect(essential).toMatchObject({ ok: true, partial: true });
    const dead = await run({ db: handle.db, connect: fakeGarmin({ fail: Object.fromEntries(Object.keys(payloads).map((k) => [k, "down"])) }).connect, now });
    expect(dead).toMatchObject({ ok: false, partial: false });
  });

  it("a failed activities call does not discard or block the other kinds", async () => {
    const res = await run({ db: handle.db, connect: fakeGarmin({ fail: { get_activities_by_date: "boom" } }).connect, now });
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
    const res = await run({ db: handle.db, connect, now, sleep: async (ms) => void (ms !== BACKFILL_PAUSE_MS && waits.push(ms)) });
    expect(res.tasks.find((t) => t.name === "activities")?.status).toBe("ok");
    expect(res.partial).toBe(false);
    expect(waits).toEqual([10_000]);
    expect(handle.db.select().from(activity).all().length).toBeGreaterThan(0);
  });

  it("gives up after two retries with waits of 10 and 30 seconds, then counts the failure", async () => {
    skipReadings();
    const waits: number[] = [];
    const fake = fakeGarmin({ messages: { get_sleep_summary: "Error retrieving sleep: Read timed out" } });
    const res = await run({ db: handle.db, connect: fake.connect, now, sleep: async (ms) => void (ms !== BACKFILL_PAUSE_MS && waits.push(ms)) });
    expect(waits).toEqual([10_000, 30_000]);
    expect(fake.calls.filter((c) => c.tool === "get_sleep_summary")).toHaveLength(3);
    expect(res.tasks.find((t) => t.name === "sleep")?.status).toBe("failed");
  });

  it("does not retry errors that are not timeouts", async () => {
    skipReadings();
    const waits: number[] = [];
    const fake = fakeGarmin({ fail: { get_hrv_data: "bad request" } });
    await run({ db: handle.db, connect: fake.connect, now, sleep: async (ms) => void (ms !== BACKFILL_PAUSE_MS && waits.push(ms)) });
    expect(waits).toEqual([]);
    expect(fake.calls.filter((c) => c.tool === "get_hrv_data")).toHaveLength(1);
  });

  it("reports an unexpected payload shape as a failure without storing it", async () => {
    const res = await run({ db: handle.db, connect: fakeGarmin({ overrides: { get_calendar_events: { events: [{ nope: 1 }] } } }).connect, now });
    expect(res.tasks.find((t) => t.name === "calendar_events")?.status).toBe("failed");
    expect(handle.db.select().from(race).all()).toHaveLength(0);
  });

  it("only ever calls tools on the read allowlist, and never a FIT or per-second splits tool", async () => {
    const fake = fakeGarmin();
    await run({ db: handle.db, connect: fake.connect, now, sleep: async () => undefined });
    for (const c of fake.calls) expect(GARMIN_READ_TOOLS as readonly string[]).toContain(c.tool);
    expect(GARMIN_READ_TOOLS.some((t) => /fit|split/i.test(t))).toBe(false);
  });
});

describe("sync windows (D41)", () => {
  /** Wraps the fake so a test can watch concurrency and answer chosen calls itself. */
  function watched(answer?: (tool: string, args: Record<string, unknown>) => GarminResult | null) {
    const fake = fakeGarmin();
    let inflight = 0;
    let max = 0;
    const connect: GarminConnector = async () => {
      const s = await fake.connect();
      return {
        async call(tool, args) {
          inflight++;
          max = Math.max(max, inflight);
          try {
            return answer?.(tool, args) ?? (await s.call(tool, args));
          } finally {
            inflight--;
          }
        },
        close: () => s.close(),
      };
    };
    return { fake, connect, maxInflight: () => max };
  }
  const activityCalls = (f: { calls: { tool: string; args: Record<string, unknown> }[] }) => f.calls.filter((c) => c.tool === "get_activities_by_date");

  it("routine sync reads the last 3 days and the next 14 days of scheduled workouts", async () => {
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    const sched = w.fake.calls.find((c) => c.tool === "get_scheduled_workouts");
    expect(sched?.args).toEqual({ start_date: "2026-11-04", end_date: "2026-11-21" });
  });

  it("does not delete a workout dated beyond the 14 day window", async () => {
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    handle.db.insert(workout).values({ garminScheduledId: "far", date: "2026-12-20", name: "Far", firstSeen: "x", lastSeen: "x" }).run();
    handle.db.insert(workout).values({ garminScheduledId: "near", date: "2026-11-20", name: "Near", firstSeen: "x", lastSeen: "x" }).run();
    await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    const ids = handle.db.select().from(workout).all().map((r) => r.garminScheduledId);
    expect(ids).toContain("far");
    expect(ids).not.toContain("near");
  });

  it("first backfill reads 180 days in 14 day windows, one at a time, with a pause between them", async () => {
    skipReadings();
    const w = watched();
    const waits: number[] = [];
    const res = await run({ db: handle.db, connect: w.connect, now, sleep: async (ms) => void waits.push(ms) });
    const windows = activityCalls(w.fake).slice(1); // the first call is the routine window
    expect(windows).toHaveLength(13);
    for (const c of windows) expect(Date.parse(`${c.args.end_date}T12:00:00Z`) - Date.parse(`${c.args.start_date}T12:00:00Z`)).toBe(13 * 86_400_000);
    expect(windows[0]?.args).toMatchObject({ end_date: TODAY });
    expect(String(windows.at(-1)?.args.start_date) <= "2026-05-12").toBe(true);
    expect(waits.filter((ms) => ms === BACKFILL_PAUSE_MS)).toHaveLength(12);
    expect(res.backfill).toEqual({ pending: 0, doneThisRun: 13, failedWindow: null });
    expect(w.maxInflight()).toBeLessThanOrEqual(2);
  });

  it("per-day kinds never run more than two calls at a time", async () => {
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    expect(w.maxInflight()).toBeLessThanOrEqual(2);
  });

  it("after the backfill a routine run makes one activities call of 3 to 14 days", async () => {
    const first = watched();
    await run({ db: handle.db, connect: first.connect, now, sleep: async () => undefined });
    const next = watched();
    const later = () => new Date(`${TODAY}T13:00:00Z`);
    await run({ db: handle.db, connect: next.connect, now: later, sleep: async () => undefined });
    const calls = activityCalls(next.fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.start_date).toBe("2026-11-04");
  });

  it("widens the routine window to cover a gap, at most 14 days", async () => {
    const first = watched();
    await run({ db: handle.db, connect: first.connect, now, sleep: async () => undefined });
    const next = watched();
    const after5 = () => new Date(`2026-11-12T12:30:00Z`);
    await run({ db: handle.db, connect: next.connect, now: after5, sleep: async () => undefined });
    expect(activityCalls(next.fake)[0]?.args.start_date).toBe("2026-11-06");
    const after30 = () => new Date(`2026-12-12T12:30:00Z`);
    const far = watched();
    await run({ db: handle.db, connect: far.connect, now: after30, sleep: async () => undefined });
    expect(activityCalls(far.fake)[0]?.args.start_date).toBe("2026-11-28");
  });

  it("a failed window stops the backfill for this run and is retried on its own next run", async () => {
    let failFrom: string | null = null;
    const w = watched((tool, args) => (tool === "get_activities_by_date" && args.start_date === failFrom ? { kind: "message", text: "Error retrieving activities: boom" } : null));
    // Find the third window's start without hard-coding the dates.
    const probe = watched();
    await run({ db: handle.db, connect: probe.connect, now, sleep: async () => undefined });
    failFrom = String(activityCalls(probe.fake)[3]?.args.start_date); // 0 routine, 1 and 2 done before it
    handle.db.delete(settings).run();
    handle.db.delete(activity).run();
    handle.db.delete(syncState).run();
    const res = await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    expect(res.backfill?.doneThisRun).toBe(2);
    expect(res.backfill?.failedWindow).toContain(failFrom ?? "");
    expect(res.backfill?.pending).toBe(11);
    expect(res.ok).toBe(true);
    expect(res.partial).toBe(false);
    failFrom = null;
    const again = watched();
    const res2 = await run({ db: handle.db, connect: again.connect, now: () => new Date(`${TODAY}T13:00:00Z`), sleep: async () => undefined });
    expect(res2.backfill).toEqual({ pending: 0, doneThisRun: 11, failedWindow: null });
    expect(activityCalls(again.fake)).toHaveLength(12); // routine plus the 11 windows still pending
  });

  it("does not backfill a database that already holds activities from before this rule", async () => {
    handle.db.insert(activity).values({ garminActivityId: "old", name: "Old", type: "running", startLocal: "2026-06-01 10:00:00", date: "2026-06-01", firstSeen: "x", lastSeen: "x" }).run();
    const w = watched();
    const res = await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    expect(activityCalls(w.fake)).toHaveLength(1);
    expect(res.backfill?.pending).toBe(0);
  });

  it("stores summaries only: no FIT or per-second payload kinds exist", async () => {
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now, sleep: async () => undefined });
    expect(handle.db.select().from(garminSnapshot).all().some((r) => /fit|split|stream/i.test(r.kind))).toBe(false);
  });
});

describe("28 day readings backfill (D45)", () => {
  const KINDS = ["training_readiness", "sleep", "hrv", "rhr", "body_battery"];
  const rows = () => handle.db.select().from(garminSnapshot).all();
  const countKind = (kind: string) => rows().filter((r) => r.kind === kind).length;
  const bbRange = (start: string, end: string) => {
    const out: { date: string; charged: number; drained: number }[] = [];
    for (let d = start; d <= end; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push({ date: d, charged: 50, drained: 40 });
    return out;
  };
  function watchedRead(answer?: (tool: string, args: Record<string, unknown>) => GarminResult | null) {
    const fake = fakeGarmin();
    let inflight = 0;
    let max = 0;
    const ranged: Record<string, unknown>[] = [];
    const connect: GarminConnector = async () => {
      const sess = await fake.connect();
      return {
        async call(tool, args) {
          inflight++;
          max = Math.max(max, inflight);
          try {
            const custom = answer?.(tool, args);
            if (custom) return custom;
            if (tool === "get_body_battery") ranged.push(args);
            if (tool === "get_body_battery") return { kind: "json", data: bbRange(String(args.start_date), String(args.end_date)) };
            return await sess.call(tool, args);
          } finally {
            inflight--;
          }
        },
        close: () => sess.close(),
      };
    };
    return { fake, connect, ranged, maxInflight: () => max };
  }
  const perDayCalls = (f: { calls: { tool: string; args: Record<string, unknown> }[] }) => f.calls.filter((c) => ["get_training_readiness", "get_sleep_summary", "get_hrv_data", "get_rhr_day"].includes(c.tool) && "date" in c.args);

  it("fills 28 days of every reading kind in two 14 day windows, never more than two calls at a time", async () => {
    const w = watchedRead();
    const res = await run({ db: handle.db, connect: w.connect, now });
    expect(res.readingsBackfill).toEqual({ pending: 0, doneThisRun: 2, failedWindow: null });
    for (const k of KINDS) expect(countKind(k), k).toBe(28);
    // 28 days each of four per-day kinds, with today's days fetched by the routine pass too, plus one ranged body battery call per window.
    expect(perDayCalls(w.fake).length).toBeGreaterThanOrEqual(4 * 27);
    expect(w.ranged.filter((a) => a.start_date !== a.end_date)).toHaveLength(2);
    expect(w.maxInflight()).toBeLessThanOrEqual(2);
    // Summaries only: each stored kind is a snapshot of a summary tool.
    expect(rows().some((r) => /fit|split|stream/i.test(r.kind))).toBe(false);
  });

  it("stores each backfilled day under its own date, with the body battery in the one entry shape", async () => {
    await run({ db: handle.db, connect: watchedRead().connect, now });
    const bb = rows().find((r) => r.kind === "body_battery" && r.date === "2026-10-20");
    expect(bb?.payload).toEqual([{ date: "2026-10-20", charged: 50, drained: 40 }]);
    expect(rows().find((r) => r.kind === "sleep" && r.date === "2026-10-20")).toBeDefined();
  });

  it("does not fetch a day twice: the second run makes no per-day reading calls for old days", async () => {
    await run({ db: handle.db, connect: watchedRead().connect, now });
    const second = watchedRead();
    await run({ db: handle.db, connect: second.connect, now: () => new Date(`${TODAY}T13:00:00Z`) });
    expect(perDayCalls(second.fake).filter((c) => c.args.date !== TODAY)).toHaveLength(0);
  });

  it("when Garmin returns nothing for older days, they are recorded as empty and not asked again", async () => {
    const old = (args: Record<string, unknown>) => String(args.date) < "2026-10-28";
    const w = watchedRead((tool, args) => (tool === "get_hrv_data" && old(args) ? { kind: "message", text: "No HRV data found" } : null));
    const res = await run({ db: handle.db, connect: w.connect, now });
    expect(res.readingsBackfill?.pending).toBe(0);
    expect(countKind("hrv")).toBe(11); // 11/10 to 27/10 is 17 days with nothing, 28 - 17 remain
    const state = handle.db.select().from(settings).all().find((r) => r.key === "garmin_readings_backfill")?.value as { empty: Record<string, string[]> };
    expect(state.empty.hrv?.length).toBe(17);
    const again = watchedRead();
    await run({ db: handle.db, connect: again.connect, now: () => new Date(`${TODAY}T13:00:00Z`) });
    expect(again.fake.calls.filter((c) => c.tool === "get_hrv_data" && String(c.args.date) < "2026-10-28")).toHaveLength(0);
  });

  it("a failed window stops the readings backfill for this run, keeps what it stored, and is retried on its own", async () => {
    let fail = true;
    const w = watchedRead((tool, args) => (fail && tool === "get_sleep_summary" && String(args.date) === "2026-10-30" ? { kind: "message", text: "Error retrieving sleep: boom" } : null));
    const res = await run({ db: handle.db, connect: w.connect, now });
    expect(res.readingsBackfill?.failedWindow).toContain("2026-10-");
    expect(res.readingsBackfill?.pending).toBeGreaterThanOrEqual(1);
    expect(res.ok).toBe(true);
    expect(res.partial).toBe(false); // a failed backfill window never makes the run partial
    const stored = countKind("sleep");
    expect(stored).toBeGreaterThan(0);
    fail = false;
    const again = watchedRead();
    const res2 = await run({ db: handle.db, connect: again.connect, now: () => new Date(`${TODAY}T13:00:00Z`) });
    expect(res2.readingsBackfill).toMatchObject({ pending: 0, failedWindow: null });
    expect(countKind("sleep")).toBe(28);
    // Only the missing days are asked for again.
    expect(again.fake.calls.filter((c) => c.tool === "get_sleep_summary" && c.args.date !== TODAY).length).toBeLessThan(28 - stored + 2);
  });
});
