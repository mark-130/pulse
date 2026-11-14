import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { addDays } from "../src/dates.js";
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

describe("readings catch-up after an outage (D74, PULSE-009)", () => {
  const KINDS = ["training_readiness", "sleep", "hrv", "rhr", "body_battery"];
  const PER_DAY = ["get_training_readiness", "get_sleep_summary", "get_hrv_data", "get_rhr_day"];
  const day = (n: number) => addDays(TODAY, n);
  const at = (n: number) => () => new Date(`${day(n)}T12:30:00Z`);
  const stored = (kind: string) => new Set(handle.db.select().from(garminSnapshot).all().filter((r) => r.kind === kind).map((r) => r.date));
  const bbRange = (start: string, end: string) => {
    const out: { date: string; charged: number; drained: number }[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, charged: 50, drained: 40 });
    return out;
  };
  /** A scripted Garmin that answers any date, records every call and how many were in flight together. `answer` may override a call. */
  function watched(answer?: (tool: string, args: Record<string, unknown>) => GarminResult | null) {
    const fake = fakeGarmin();
    let inflight = 0;
    let max = 0;
    const connect: GarminConnector = async () => {
      const sess = await fake.connect();
      return {
        async call(tool, args) {
          inflight++;
          max = Math.max(max, inflight);
          try {
            const custom = answer?.(tool, args);
            if (custom) return custom;
            if (tool === "get_body_battery") return { kind: "json", data: bbRange(String(args.start_date), String(args.end_date)) };
            return await sess.call(tool, args);
          } finally {
            inflight--;
          }
        },
        close: () => sess.close(),
      };
    };
    return { fake, connect, maxInflight: () => max };
  }
  const perDayDates = (f: { calls: { tool: string; args: Record<string, unknown> }[] }, from = 0) => f.calls.slice(from).filter((c) => PER_DAY.includes(c.tool) && "date" in c.args).map((c) => String(c.args.date));
  const initial = async () => {
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now: at(0) });
    return w;
  };
  const readingsState = () => handle.db.select().from(settings).where(eq(settings.key, "garmin_readings_backfill")).get()?.value as { windows: { from: string; to: string; done: boolean }[]; empty: Record<string, string[]>; through: string };

  it("A: the first run still fills 28 days of all five kinds, two calls at a time, and records how far windows reach", async () => {
    const w = watched();
    const res = await run({ db: handle.db, connect: w.connect, now: at(0) });
    expect(res.readingsBackfill).toEqual({ pending: 0, doneThisRun: 2, failedWindow: null });
    for (const k of KINDS) expect(stored(k).size, k).toBe(28);
    expect(w.maxInflight()).toBeLessThanOrEqual(2);
    expect(readingsState().through).toBe(TODAY);
    expect(readingsState().windows.map((x) => [x.from, x.to])).toEqual([[day(-13), day(0)], [day(-27), day(-14)]]);
  });

  it("B: after a two day outage the next working run fetches the two missed days, and only those", async () => {
    await initial();
    // Pulse or Garmin was down on days 1 and 2. Nothing ran. Day 3 works.
    const w = watched();
    const res = await run({ db: handle.db, connect: w.connect, now: at(3) });
    expect(res.readingsBackfill).toMatchObject({ pending: 0, doneThisRun: 1, failedWindow: null });
    for (const k of KINDS) for (const d of [day(1), day(2), day(3)]) expect(stored(k).has(d), `${k} ${d}`).toBe(true);
    // Per-day calls: today's routine pass, plus exactly the two missed days. Nothing older is asked for.
    expect([...new Set(perDayDates(w.fake))].sort()).toEqual([day(1), day(2), day(3)]);
    expect(readingsState().through).toBe(day(2));
  });

  it("B: an outage where Garmin answers with errors does not lose the days either", async () => {
    await initial();
    const down = watched((tool) => ({ kind: "message", text: `Error retrieving ${tool}: Garmin is down` }));
    await run({ db: handle.db, connect: down.connect, now: at(1) });
    await run({ db: handle.db, connect: down.connect, now: at(2) });
    const up = watched();
    await run({ db: handle.db, connect: up.connect, now: at(3) });
    for (const k of KINDS) for (const d of [day(1), day(2)]) expect(stored(k).has(d), `${k} ${d}`).toBe(true);
  });

  it("C: a gap longer than 28 days is caught up over several runs, two windows at most per run, with no day skipped", async () => {
    await initial();
    const gap = 59; // days 1 to 59 missing, today is day 60
    const runs: { done: number; pending: number }[] = [];
    let maxInflight = 0;
    for (let i = 0; i < 4; i++) {
      const w = watched();
      const before = w.fake.calls.length;
      const res = await run({ db: handle.db, connect: w.connect, now: at(gap + 1) });
      maxInflight = Math.max(maxInflight, w.maxInflight());
      runs.push({ done: res.readingsBackfill?.doneThisRun ?? 0, pending: res.readingsBackfill?.pending ?? 0 });
      // However long the gap, one run asks for at most 2 windows of 14 days per kind.
      expect(new Set(perDayDates(w.fake, before)).size).toBeLessThanOrEqual(28 + 1);
    }
    expect(runs).toEqual([{ done: 2, pending: 3 }, { done: 2, pending: 1 }, { done: 1, pending: 0 }, { done: 0, pending: 0 }]);
    for (const k of KINDS) for (let n = 1; n <= gap + 1; n++) expect(stored(k).has(day(n)), `${k} day ${n}`).toBe(true);
    expect(maxInflight).toBeLessThanOrEqual(2);
  });

  it("C: the newest missed days come first, so an interrupted catch-up has the recent days", async () => {
    await initial();
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now: at(60) });
    expect(stored("sleep").has(day(59))).toBe(true);
    expect(stored("sleep").has(day(32))).toBe(true);
    expect(stored("sleep").has(day(31))).toBe(false);
  });

  it("D: stored days are not fetched again, known empty days (older than 2 days) are not asked for again, and repeated runs add no rows", async () => {
    await initial();
    const noHrv = (tool: string, args: Record<string, unknown>): GarminResult | null => (tool === "get_hrv_data" && args.date === day(1) ? { kind: "message", text: "No HRV data found" } : null);
    await run({ db: handle.db, connect: watched(noHrv).connect, now: at(4) });
    expect(stored("hrv").has(day(1))).toBe(false);
    expect(readingsState().empty.hrv).toContain(day(1));
    const rowsAfter = handle.db.select().from(garminSnapshot).all().length;
    for (let i = 0; i < 2; i++) {
      const again = watched(noHrv);
      await run({ db: handle.db, connect: again.connect, now: () => new Date(`${day(4)}T1${i}:00:00Z`) });
      expect(perDayDates(again.fake).filter((d) => d !== day(4))).toEqual([]);
      expect(again.fake.calls.filter((c) => c.tool === "get_hrv_data" && c.args.date === day(1))).toHaveLength(0);
    }
    expect(handle.db.select().from(garminSnapshot).all().length).toBe(rowsAfter);
  });

  it("E: a failed catch-up window keeps what was stored, is retried alone, and other kinds carry on", async () => {
    await initial();
    let fail = true;
    const w = watched((tool, args) => (fail && tool === "get_sleep_summary" && args.date === day(2) ? { kind: "message", text: "Error retrieving sleep: boom" } : null));
    const res = await run({ db: handle.db, connect: w.connect, now: at(3) });
    expect(res.readingsBackfill?.failedWindow).toBe(`${day(1)} to ${day(2)}`);
    expect(res.readingsBackfill?.pending).toBe(1);
    expect(res.partial).toBe(false);
    // The other kinds were stored, including body battery, whatever happened to sleep.
    for (const k of ["training_readiness", "hrv", "rhr", "body_battery"]) for (const d of [day(1), day(2)]) expect(stored(k).has(d), `${k} ${d}`).toBe(true);
    expect(stored("sleep").has(day(1))).toBe(true);
    expect(stored("sleep").has(day(2))).toBe(false);
    fail = false;
    const again = watched();
    const res2 = await run({ db: handle.db, connect: again.connect, now: () => new Date(`${day(3)}T13:30:00Z`) });
    expect(res2.readingsBackfill).toMatchObject({ pending: 0, failedWindow: null });
    expect(stored("sleep").has(day(2))).toBe(true);
    // Only the missing sleep day is asked for again.
    expect(again.fake.calls.filter((c) => PER_DAY.includes(c.tool) && c.args.date !== day(3)).map((c) => [c.tool, c.args.date])).toEqual([["get_sleep_summary", day(2)]]);
  });

  it("F: today's readings still sync, and the history import range is left alone", async () => {
    await initial();
    const range = { state: "complete", days: 730, startedAt: "2026-11-01T09:00:00.000Z", rangeFrom: "2024-11-03", rangeTo: "2026-11-01" };
    handle.db.insert(settings).values({ key: "history_import", value: range }).run();
    await run({ db: handle.db, connect: watched().connect, now: at(5) });
    for (const k of KINDS) expect(stored(k).has(day(5)), k).toBe(true);
    expect(handle.db.select().from(settings).where(eq(settings.key, "history_import")).get()?.value).toEqual(range);
  });

  it("F: a state saved before D74 (no through) continues from its newest window", async () => {
    await initial();
    const s = readingsState();
    const legacy: Record<string, unknown> = { ...s };
    delete legacy.through;
    handle.db.update(settings).set({ value: legacy }).where(eq(settings.key, "garmin_readings_backfill")).run();
    const w = watched();
    await run({ db: handle.db, connect: w.connect, now: at(2) });
    expect(stored("rhr").has(day(1))).toBe(true);
    expect(readingsState().through).toBe(day(1));
    expect([...new Set(perDayDates(w.fake))].sort()).toEqual([day(1), day(2)]);
  });

  it("G: catch-up calls keep the retry waits of 10 and 30 seconds and never exceed two in flight", async () => {
    await initial();
    const waits: number[] = [];
    let hrvCalls = 0;
    const w = watched((tool, args) => (tool === "get_hrv_data" && args.date === day(1) ? (hrvCalls++, { kind: "message", text: "Error retrieving hrv: Read timed out" }) : null));
    const res = await run({ db: handle.db, connect: w.connect, now: at(2), sleep: async (ms) => void (ms !== BACKFILL_PAUSE_MS && waits.push(ms)) });
    expect(waits).toEqual([10_000, 30_000]);
    expect(hrvCalls).toBe(3);
    expect(res.readingsBackfill?.failedWindow).toBe(`${day(1)} to ${day(1)}`);
    expect(w.maxInflight()).toBeLessThanOrEqual(2);
  });

  it("recency guard: a no-data answer for yesterday is not recorded as empty, is asked again, and once data arrives it is stored and left alone", async () => {
    await initial();
    let hrvAsks = 0;
    let available = false;
    const answer = (tool: string, args: Record<string, unknown>): GarminResult | null => {
      if (tool !== "get_hrv_data" || args.date !== day(2)) return null;
      hrvAsks++;
      return available ? null : { kind: "message", text: "No HRV data found" };
    };
    const w1 = watched(answer);
    const r1 = await run({ db: handle.db, connect: w1.connect, now: at(3) });
    expect(hrvAsks).toBe(1);
    expect(readingsState().empty.hrv ?? []).not.toContain(day(2));
    expect(stored("hrv").has(day(2))).toBe(false);
    // The window stays open, and a held window is not a failure.
    expect(r1.readingsBackfill).toMatchObject({ pending: 1, failedWindow: null });
    // Inside the 6 hour cooldown (D75) it is not asked again.
    await run({ db: handle.db, connect: watched(answer).connect, now: () => new Date(`${day(3)}T14:00:00Z`) });
    expect(hrvAsks).toBe(1);
    // Past the cooldown it is.
    const w2 = watched(answer);
    await run({ db: handle.db, connect: w2.connect, now: () => new Date(`${day(3)}T19:00:00Z`) });
    expect(hrvAsks).toBe(2);
    available = true;
    const w3 = watched(answer);
    const r3 = await run({ db: handle.db, connect: w3.connect, now: () => new Date(`${day(4)}T02:00:00Z`) });
    expect(hrvAsks).toBe(3);
    expect(stored("hrv").has(day(2))).toBe(true);
    expect(r3.readingsBackfill).toMatchObject({ pending: 0, failedWindow: null });
    const w4 = watched(answer);
    await run({ db: handle.db, connect: w4.connect, now: () => new Date(`${day(4)}T09:00:00Z`) });
    expect(hrvAsks).toBe(3);
    expect(perDayDates(w4.fake).filter((d) => d !== day(4))).toEqual([]);
  });

  it("recency guard: a no-data answer for a day older than 2 days is recorded as empty and not asked again", async () => {
    await initial();
    let asks = 0;
    const answer = (tool: string, args: Record<string, unknown>): GarminResult | null => (tool === "get_hrv_data" && args.date === day(1) ? (asks++, { kind: "message", text: "No HRV data found" }) : null);
    // Day 1 is the third day back from day 3 (still recent), and older from day 4.
    await run({ db: handle.db, connect: watched(answer).connect, now: at(3) });
    expect(readingsState().empty.hrv ?? []).not.toContain(day(1));
    await run({ db: handle.db, connect: watched(answer).connect, now: at(4) });
    expect(readingsState().empty.hrv).toContain(day(1));
    const before = asks;
    await run({ db: handle.db, connect: watched(answer).connect, now: at(5) });
    await run({ db: handle.db, connect: watched(answer).connect, now: at(5) });
    expect(asks).toBe(before);
    expect(stored("hrv").has(day(1))).toBe(false);
  });

  it("recency guard: calls per run stay bounded when Garmin keeps saying no data, and never more than two at a time", async () => {
    await initial();
    const none = (tool: string): GarminResult | null => (PER_DAY.includes(tool) || tool === "get_body_battery" ? { kind: "message", text: "No data found" } : null);
    for (let i = 0; i < 3; i++) {
      const w = watched(none);
      let calls = 0;
      const counting = async () => {
        const s = await w.connect();
        return { call: (t: Parameters<typeof s.call>[0], a: Record<string, unknown>) => (calls++, s.call(t, a)), close: () => s.close() };
      };
      await run({ db: handle.db, connect: counting, now: () => new Date(`${day(3)}T1${i}:00:00Z`) });
      // The routine pass is about 20 calls. The held days (2 and 1 are the last two before today, 3 is today) add at most
      // 2 days x 4 per-day kinds + 1 body battery call, never a whole window.
      const readingCalls = w.fake.calls.length;
      expect(readingCalls).toBeLessThanOrEqual(30);
      expect(calls).toBeGreaterThan(0);
      expect(w.maxInflight()).toBeLessThanOrEqual(2);
    }
    expect(readingsState().empty.hrv ?? []).toEqual([]);
  });
});

describe("retry cooldown for recent no-data readings (D75, PULSE-010)", () => {
  const day = (n: number) => addDays(TODAY, n);
  const at = (n: number, hhmm = "12:30") => () => new Date(`${day(n)}T${hhmm}:00Z`);
  const PER_DAY = ["get_training_readiness", "get_sleep_summary", "get_hrv_data", "get_rhr_day"];
  const stored = (kind: string) => new Set(handle.db.select().from(garminSnapshot).all().filter((r) => r.kind === kind).map((r) => r.date));
  const state = () => handle.db.select().from(settings).where(eq(settings.key, "garmin_readings_backfill")).get()?.value as { empty: Record<string, string[]>; retryAfter?: Record<string, string> };
  const bbRange = (start: string, end: string) => {
    const out: { date: string; charged: number; drained: number }[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, charged: 50, drained: 40 });
    return out;
  };
  /** Garmin with a call log. `hold` says which kind and date answer "no data". Body battery answers by range. */
  function garmin(hold: (tool: string, date: string) => boolean) {
    const fake = fakeGarmin();
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    let inflight = 0;
    let max = 0;
    const connect: GarminConnector = async () => {
      const sess = await fake.connect();
      return {
        async call(tool, args) {
          calls.push({ tool, args });
          inflight++;
          max = Math.max(max, inflight);
          try {
            if (tool === "get_body_battery") {
              const all = bbRange(String(args.start_date), String(args.end_date));
              const data = all.filter((e) => !hold(tool, e.date));
              return data.length === 0 ? { kind: "message", text: "No body battery data" } : { kind: "json", data };
            }
            if (PER_DAY.includes(tool) && typeof args.date === "string" && hold(tool, args.date)) return { kind: "message", text: "No data found" };
            return await sess.call(tool, args);
          } finally {
            inflight--;
          }
        },
        close: () => sess.close(),
      };
    };
    return { calls, connect, maxInflight: () => max };
  }
  const asks = (g: { calls: { tool: string; args: Record<string, unknown> }[] }, tool: string, date: string) => g.calls.filter((c) => c.tool === tool && c.args.date === date).length;
  const bbAsks = (g: { calls: { tool: string; args: Record<string, unknown> }[] }) => g.calls.filter((c) => c.tool === "get_body_battery" && c.args.start_date !== c.args.end_date).length;
  const initial = () => run({ db: handle.db, connect: garmin(() => false).connect, now: at(0) });
  // Yesterday (day 2 seen from day 3) is a recent day that a catch-up window covers.
  const sleepHeld = (tool: string, d: string) => tool === "get_sleep_summary" && d === day(2);

  it("does not ask again for a recent no-data reading on every 30 minute run, and records when it may", async () => {
    await initial();
    const first = garmin(sleepHeld);
    await run({ db: handle.db, connect: first.connect, now: at(3, "12:30") });
    expect(asks(first, "get_sleep_summary", day(2))).toBe(1);
    expect(state().retryAfter?.[`sleep|${day(2)}`]).toBe(`${day(3)}T18:30:00.000Z`);
    for (const t of ["13:00", "13:30", "17:30", "18:29"]) {
      const g = garmin(sleepHeld);
      await run({ db: handle.db, connect: g.connect, now: at(3, t) });
      expect(asks(g, "get_sleep_summary", day(2)), t).toBe(0);
    }
    // Not recorded as known empty: it stays recoverable.
    expect(state().empty.sleep ?? []).not.toContain(day(2));
  });

  it("asks again once the cooldown has expired, and stores the reading when it has arrived", async () => {
    await initial();
    await run({ db: handle.db, connect: garmin(sleepHeld).connect, now: at(3, "12:30") });
    const still = garmin(sleepHeld);
    await run({ db: handle.db, connect: still.connect, now: at(3, "18:30") });
    expect(asks(still, "get_sleep_summary", day(2))).toBe(1);
    expect(state().retryAfter?.[`sleep|${day(2)}`]).toBe(`${day(4)}T00:30:00.000Z`);
    const ready = garmin(() => false);
    await run({ db: handle.db, connect: ready.connect, now: at(4, "01:00") });
    expect(asks(ready, "get_sleep_summary", day(2))).toBe(1);
    expect(stored("sleep").has(day(2))).toBe(true);
    expect(state().retryAfter?.[`sleep|${day(2)}`]).toBeUndefined();
  });

  it("keeps a stored reading and retries only the kind that is still missing", async () => {
    await initial();
    const hrvHeld = (tool: string, d: string) => tool === "get_hrv_data" && d === day(2);
    // Sleep is held first, then arrives while HRV is still missing.
    await run({ db: handle.db, connect: garmin((t, d) => sleepHeld(t, d) || hrvHeld(t, d)).connect, now: at(3, "12:30") });
    const g = garmin(hrvHeld);
    await run({ db: handle.db, connect: g.connect, now: at(3, "19:00") });
    expect(stored("sleep").has(day(2))).toBe(true);
    expect(stored("hrv").has(day(2))).toBe(false);
    expect(asks(g, "get_sleep_summary", day(2))).toBe(1);
    expect(asks(g, "get_hrv_data", day(2))).toBe(1);
    // Later, after sleep is stored and while HRV is cooling, only the day's other calls are left: neither kind is asked.
    const later = garmin(hrvHeld);
    await run({ db: handle.db, connect: later.connect, now: at(3, "19:30") });
    expect(asks(later, "get_sleep_summary", day(2))).toBe(0);
    expect(asks(later, "get_hrv_data", day(2))).toBe(0);
    expect(asks(later, "get_training_readiness", day(2))).toBe(0);
    expect(asks(later, "get_rhr_day", day(2))).toBe(0);
  });

  it("applies the same cooldown to body battery's ranged call", async () => {
    await initial();
    const bbHeld = (tool: string, d: string) => tool === "get_body_battery" && d === day(2);
    // Held means the range answers without that day. Days 1 and 3 do arrive, so the call is made once for the window.
    const first = garmin(bbHeld);
    await run({ db: handle.db, connect: first.connect, now: at(3, "12:30") });
    expect(bbAsks(first)).toBe(1);
    expect(state().retryAfter?.[`body_battery|${day(2)}`]).toBeDefined();
    expect(stored("body_battery").has(day(1))).toBe(true);
    const inside = garmin(bbHeld);
    await run({ db: handle.db, connect: inside.connect, now: at(3, "13:00") });
    expect(bbAsks(inside)).toBe(0);
    const after = garmin(bbHeld);
    await run({ db: handle.db, connect: after.connect, now: at(3, "19:00") });
    expect(bbAsks(after)).toBe(1);
    // If the cooling day appears in a call made for another reason, it is stored.
    expect(stored("body_battery").has(day(2))).toBe(false);
    const ready = garmin(() => false);
    await run({ db: handle.db, connect: ready.connect, now: at(4, "02:00") });
    expect(stored("body_battery").has(day(2))).toBe(true);
  });

  it("makes no call and no pause for a window whose missing days are all cooling", async () => {
    await initial();
    const none = (tool: string, d: string) => (PER_DAY.includes(tool) || tool === "get_body_battery") && d === day(2);
    await run({ db: handle.db, connect: garmin(none).connect, now: at(3, "12:30") });
    const g = garmin(none);
    const pauses: number[] = [];
    await run({ db: handle.db, connect: g.connect, now: at(3, "13:00"), sleep: async (ms) => void (ms === BACKFILL_PAUSE_MS && pauses.push(ms)) });
    expect(g.calls.filter((c) => c.args.date === day(2) || (c.tool === "get_body_battery" && c.args.start_date !== c.args.end_date))).toEqual([]);
    expect(pauses).toEqual([]);
  });

  it("still catches up an outage longer than 28 days over bounded runs while recent days cool down", async () => {
    await initial();
    const held = (tool: string, d: string) => tool === "get_hrv_data" && d === day(59);
    const done: number[] = [];
    let maxInflight = 0;
    for (let i = 0; i < 4; i++) {
      const g = garmin(held);
      const res = await run({ db: handle.db, connect: g.connect, now: () => new Date(`${day(60)}T1${i}:00:00Z`) });
      done.push(res.readingsBackfill?.doneThisRun ?? 0);
      maxInflight = Math.max(maxInflight, g.maxInflight());
      expect(res.readingsBackfill?.doneThisRun ?? 0).toBeLessThanOrEqual(2);
    }
    // Five windows: the one holding the cooling day stays open and takes no share of the two per run, the other four finish.
    expect(done).toEqual([2, 2, 0, 0]);
    for (const k of ["training_readiness", "sleep", "rhr", "body_battery"]) for (let n = 1; n <= 60; n++) expect(stored(k).has(day(n)), `${k} ${day(n)}`).toBe(true);
    for (let n = 1; n <= 60; n++) if (n !== 59) expect(stored("hrv").has(day(n)), `hrv ${day(n)}`).toBe(true);
    expect(maxInflight).toBeLessThanOrEqual(2);
    // The held day was asked for once only in these hour-apart runs, and stays recoverable.
    expect(state().empty.hrv ?? []).not.toContain(day(59));
  });

  it("does not fetch stored or known-empty dates again, and adds no rows", async () => {
    await initial();
    const old = (tool: string, d: string) => tool === "get_rhr_day" && d === day(1);
    await run({ db: handle.db, connect: garmin(old).connect, now: at(5, "12:30") });
    expect(state().empty.rhr).toContain(day(1));
    const rows = handle.db.select().from(garminSnapshot).all().length;
    const g = garmin(old);
    await run({ db: handle.db, connect: g.connect, now: at(5, "20:00") });
    expect(g.calls.filter((c) => PER_DAY.includes(c.tool) && c.args.date !== day(5))).toEqual([]);
    expect(handle.db.select().from(garminSnapshot).all().length).toBe(rows);
  });

  it("keeps the retry waits of 10 and 30 seconds and the limit of two calls at a time", async () => {
    await initial();
    const fake = fakeGarmin();
    let hrvCalls = 0;
    let inflight = 0;
    let max = 0;
    const connect: GarminConnector = async () => {
      const sess = await fake.connect();
      return {
        async call(tool, args) {
          inflight++;
          max = Math.max(max, inflight);
          try {
            if (tool === "get_hrv_data" && args.date === day(2)) return (hrvCalls++, { kind: "message", text: "Error retrieving hrv: Read timed out" } as GarminResult);
            if (tool === "get_body_battery") return { kind: "json", data: bbRange(String(args.start_date), String(args.end_date)) };
            return await sess.call(tool, args);
          } finally {
            inflight--;
          }
        },
        close: () => sess.close(),
      };
    };
    const waits: number[] = [];
    const res = await run({ db: handle.db, connect, now: at(3), sleep: async (ms) => void (ms !== BACKFILL_PAUSE_MS && waits.push(ms)) });
    expect(waits).toEqual([10_000, 30_000]);
    expect(hrvCalls).toBe(3);
    expect(res.readingsBackfill?.failedWindow).toBe(`${day(1)} to ${day(2)}`);
    expect(max).toBeLessThanOrEqual(2);
    // A failure is not a no-data answer, so it gets no cooldown and is retried on the next run.
    expect(state().retryAfter?.[`hrv|${day(2)}`]).toBeUndefined();
  });

  it("leaves the history import range alone", async () => {
    await initial();
    const range = { state: "complete", days: 730, startedAt: "2026-11-01T09:00:00.000Z", rangeFrom: "2024-11-03", rangeTo: "2026-11-01" };
    handle.db.insert(settings).values({ key: "history_import", value: range }).run();
    await run({ db: handle.db, connect: garmin(sleepHeld).connect, now: at(3) });
    await run({ db: handle.db, connect: garmin(sleepHeld).connect, now: at(3, "19:00") });
    expect(handle.db.select().from(settings).where(eq(settings.key, "history_import")).get()?.value).toEqual(range);
  });
});
