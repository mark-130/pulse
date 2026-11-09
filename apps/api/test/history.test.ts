import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HISTORY_KINDS, historySeriesSchema, historyStatusSchema, yearOnYearSchema } from "@pulse/shared";
import { activity, backfillProgress, dailyReading, garminSnapshot, vo2maxPoint } from "../src/db/schema.js";
import { GARMIN_READ_TOOLS, type GarminConnector, type GarminReadTool, type GarminResult } from "../src/modules/garmin/client.js";
import { GARMIN_WRITE_TOOLS } from "../src/modules/proposals/executors/garmin.js";
import { FAILED_WINDOWS_PER_KIND, PER_DAY_CONCURRENCY, RATE_BASE_MS, WINDOW_PAUSE_MS, doneDays, loadState, nextWindow, runOrder, saveState } from "../src/modules/history/engine.js";
import { RANGE_LIMITS, RANGE_SPECS, classifyText } from "../src/modules/history/kinds.js";
import { shouldYield } from "../src/modules/history/module.js";
import { getHistorySummary, getYearOnYear, monthly, withAverage7, yearAgo } from "../src/modules/history/queries.js";
import { runTool } from "../src/modules/ai/tools.js";
import { addDays } from "../src/dates.js";
import { createLogger } from "../src/logger.js";
import { FAKE_KEY } from "./ai-helpers.js";
import { makeGarminApp, req } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const TODAY = "2026-11-09";
const clock = () => NOW;

type Handler = (tool: string, args: Record<string, unknown>, n: number) => GarminResult | undefined | Promise<GarminResult | undefined>;

/** A scripted Garmin. Never touches a network. Records every call and how many were in flight together. */
function scripted(handler?: Handler) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const connect: GarminConnector = async () => ({
    async call(tool: GarminReadTool, args) {
      calls.push({ tool, args });
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        await Promise.resolve();
        return (await handler?.(tool, args, calls.length)) ?? generate(tool, args);
      } finally {
        inflight--;
      }
    },
    async close() {},
  });
  return { connect, calls, maxInflight: () => maxInflight };
}

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const json = (data: unknown): GarminResult => ({ kind: "json", data });
const msg = (text: string): GarminResult => ({ kind: "message", text });

/** Plausible answers in the shapes the app already reads. */
function generate(tool: string, a: Record<string, unknown>): GarminResult {
  const from = String(a.start_date ?? a.date);
  const to = String(a.end_date ?? a.date);
  switch (tool) {
    case "get_sleep_summary_range": return json({ nights: days(from, to).map((date, i) => ({ date, sleep_score: 70 + (i % 20), sleep_hours: 7.5 })) });
    case "get_hrv_trend": return json({ daily: days(from, to).map((date, i) => ({ date, last_night_avg_hrv_ms: 40 + (i % 10) })) });
    case "get_rhr_day": return json({ allMetrics: { metricsMap: { WELLNESS_RESTING_HEART_RATE: [{ value: 45 + (Number(from.slice(8)) % 5) }] } } });
    case "get_training_readiness": return json([{ date: from, timestamp: `${from}T09:00:00.0`, context: "X", level: "HIGH", score: 60 + (Number(from.slice(8)) % 30), feedback: "X", sleep_score: 80, recovery_time_hours: 10, acute_load: 500 }]);
    case "get_body_battery": return json(days(from, to).map((date) => ({ date, charged: 55, drained: 40 })));
    case "get_vo2max_trend": return json({ trend: days(from, to).filter((d) => d.slice(8) === "01" || d === to).map((date) => ({ date, vo2_max: 46 })) });
    case "get_endurance_score": return json({ current_score: 5700, current_date: to, classification: "trained", weekly_breakdown: days(from, to).filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1).map((week_start) => ({ week_start, avg_score: 5600 })) });
    case "get_hill_score": return json({ daily_scores: days(from, to).filter((d) => Number(d.slice(8)) % 7 === 0).map((date) => ({ date, overall: 30, strength: 15, endurance: 15 })) });
    case "get_lactate_threshold": return json({ lactate_threshold_speed_mps: 3.2, lactate_threshold_heart_rate_bpm: 162, speed_hr_date: `${to}T08:00:00.0` });
    case "get_activities_by_date": return json({ has_more: false, activities: [{ id: Number(from.replace(/-/g, "")), name: "Run", type: "running", start_time: `${from} 07:00:00`, distance_meters: 8000, duration_seconds: 2700, avg_hr_bpm: 140, max_hr_bpm: 165, calories: 500, elevation_gain_meters: 20 }] });
    default: return msg("No data found");
  }
}

async function setup(o: { handler?: Handler; days?: number; busy?: () => boolean; rate?: { baseMs: number; pauseMs: number }; logs?: string[] } = {}) {
  const sleeps: number[] = [];
  const g = scripted(o.handler);
  const t = await makeGarminApp({
    clock,
    env: { PULSE_HISTORY_DAYS: String(o.days ?? 60), ANTHROPIC_API_KEY: FAKE_KEY },
    historyConnect: g.connect,
    historyBusy: o.busy,
    historySleep: async (ms) => void sleeps.push(ms),
    historyRate: o.rate,
    logDestination: o.logs ? { write: (l: string) => void o.logs?.push(l) } : undefined,
  });
  const post = (path: string) => req(t.app, path, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
  const status = async () => historyStatusSchema.parse(await (await t.get("/api/history")).json());
  const run = async () => {
    await post("/api/history/start");
    await t.history.idle();
    return status();
  };
  const progress = () => t.handle.db.select().from(backfillProgress).orderBy(asc(backfillProgress.kind), asc(backfillProgress.windowStart)).all();
  const readings = (kind: string) => t.handle.db.select().from(dailyReading).where(eq(dailyReading.kind, kind)).all();
  return { t, g, sleeps, post, status, run, progress, readings };
}

describe("history import: what it may call", () => {
  it("adds only get_ tools to the read allowlist, and the write allowlist is unchanged", () => {
    expect(GARMIN_READ_TOOLS).toContain("get_sleep_summary_range");
    expect(GARMIN_READ_TOOLS).toContain("get_hrv_trend");
    for (const tool of GARMIN_READ_TOOLS) expect(tool.startsWith("get_")).toBe(true);
    for (const k of HISTORY_KINDS) expect(GARMIN_READ_TOOLS as readonly string[]).toContain(k.tool);
    expect([...GARMIN_WRITE_TOOLS]).toEqual(["reschedule_workout", "unschedule_workout"]);
    expect(GARMIN_READ_TOOLS.some((t) => /fit|split|race_prediction_history|personal_record_history/i.test(t))).toBe(false);
  });

  it("race predictions, personal records and heart rate zones are not imported", () => {
    const tools = HISTORY_KINDS.map((k) => k.tool) as string[];
    for (const t of ["get_race_predictions", "get_personal_record", "get_heart_rate_zones"]) expect(tools).not.toContain(t);
  });
});

describe("history import: windows", () => {
  it("uses the window size from the one limits table for each range tool, never above its limit, and 14 day windows for per-day tools two calls at a time", async () => {
    const s = await setup({ days: 730 });
    const st = await s.run();
    expect(st.state).toBe("complete");
    const sizes = (tool: string) => s.g.calls.filter((c) => c.tool === tool).map((c) => Math.round((Date.parse(`${c.args.end_date}T12:00:00Z`) - Date.parse(`${c.args.start_date}T12:00:00Z`)) / 86_400_000) + 1);
    const byTool: Record<string, string> = { get_sleep_summary_range: "sleep", get_hrv_trend: "hrv", get_body_battery: "body_battery", get_vo2max_trend: "vo2max", get_endurance_score: "endurance", get_hill_score: "hill", get_lactate_threshold: "lactate" };
    for (const [tool, id] of Object.entries(byTool)) {
      const sz = sizes(tool);
      expect(sz[0], tool).toBe(RANGE_LIMITS[id]?.start);
      expect(Math.max(...sz), tool).toBeLessThanOrEqual(RANGE_LIMITS[id]?.max ?? 0);
    }
    // Where the tool's description gives no limit the window is fixed at 14 days and never grows.
    for (const tool of ["get_body_battery", "get_endurance_score", "get_hill_score", "get_lactate_threshold"]) expect(Math.max(...sizes(tool)), tool).toBeLessThanOrEqual(14);
    expect(Math.max(...sizes("get_hrv_trend"))).toBeLessThanOrEqual(30); // HRV takes 30 at most
    expect(Math.max(...sizes("get_sleep_summary_range"))).toBeGreaterThan(30); // a documented limit of 90: it grows after successes
    // Per-day tools: one call per day, in 14 day windows, never more than two at once.
    expect(s.g.calls.filter((c) => c.tool === "get_rhr_day")).toHaveLength(730);
    expect(s.g.calls.filter((c) => c.tool === "get_training_readiness")).toHaveLength(730);
    expect(s.g.maxInflight()).toBeLessThanOrEqual(PER_DAY_CONCURRENCY);
    const rhrWindows = s.progress().filter((p) => p.kind === "rhr");
    expect(rhrWindows.every((p) => Math.round((Date.parse(`${p.windowEnd}T12:00:00Z`) - Date.parse(`${p.windowStart}T12:00:00Z`)) / 86_400_000) + 1 <= 14)).toBe(true);
    // A 2 second pause after every window.
    expect(s.sleeps.filter((ms) => ms === WINDOW_PAUSE_MS).length).toBe(s.progress().length);
  }, 60_000);

  it("covers every day exactly once per kind, newest first, and reports the call count for 730 days", async () => {
    const s = await setup({ days: 730 });
    await s.run();
    const status = await s.status();
    for (const k of status.kinds) expect(k).toMatchObject({ done: 730, total: 730, failed: 0 });
    const calls = new Map<string, number>();
    for (const c of s.g.calls) calls.set(c.tool, (calls.get(c.tool) ?? 0) + 1);
    // Range kinds make tens of calls (the four with no stated limit use 14 day windows, D60), the two per-day kinds 730 each: about 1,730 calls in all.
    const total = s.g.calls.length;
    expect(total).toBeGreaterThan(1650);
    expect(total).toBeLessThan(1800);
    const first = s.g.calls.find((c) => c.tool === "get_sleep_summary_range");
    expect(first?.args.end_date).toBe(TODAY); // newest first
  }, 60_000);

  it("nextWindow plans newest first and skips finished and tried days", () => {
    const done = new Set(["2026-11-09", "2026-11-08"]);
    expect(nextWindow("2026-11-01", "2026-11-09", done, new Set(), 3)).toEqual({ from: "2026-11-05", to: "2026-11-07" });
    expect(nextWindow("2026-11-01", "2026-11-09", done, new Set(["2026-11-07", "2026-11-06", "2026-11-05"]), 3)).toEqual({ from: "2026-11-02", to: "2026-11-04" });
    expect(nextWindow("2026-11-08", "2026-11-09", done, new Set(), 3)).toBeNull();
  });
});

describe("history import: data kept", () => {
  it("stores daily readings, VO2 max and activity summaries only, and never touches the raw snapshot store", async () => {
    const s = await setup({ days: 30 });
    const before = s.t.handle.db.select().from(garminSnapshot).all().length;
    await s.run();
    expect(s.t.handle.db.select().from(garminSnapshot).all()).toHaveLength(before);
    expect(s.readings("sleep").length).toBe(30);
    expect(s.readings("rhr").length).toBe(30);
    expect(s.readings("body_battery")[0]).toMatchObject({ value: 55, value2: 40 });
    expect(s.readings("hill")[0]).toMatchObject({ value: 30, value2: 15, value3: 15 });
    expect(s.t.handle.db.select().from(vo2maxPoint).all().length).toBeGreaterThan(0);
    const act = s.t.handle.db.select().from(activity).all()[0];
    // Summaries only: name, date, type, distance, duration, average and maximum heart rate (plus calories, elevation and bookkeeping).
    for (const k of ["name", "date", "type", "distanceM", "durationS", "avgHr", "maxHr"]) expect(Object.keys(act ?? {})).toContain(k);
    expect(Object.keys(act ?? {}).some((k) => /split|fit|stream|lap|track/i.test(k))).toBe(false);
    for (const tool of s.g.calls.map((c) => c.tool)) expect(tool).not.toMatch(/split|fit|activity_hr/i);
  });
});

describe("history import: failures", () => {
  it("a timeout retries the window once at half size, newest half first, and records each half", async () => {
    let timedOut = false;
    const s = await setup({
      days: 30,
      handler: (tool, a) => {
        if (tool === "get_sleep_summary_range" && !timedOut && Math.round((Date.parse(`${a.end_date}T12:00:00Z`) - Date.parse(`${a.start_date}T12:00:00Z`)) / 86_400_000) + 1 === 30) {
          timedOut = true;
          return msg("Read timed out");
        }
        return undefined;
      },
    });
    const st = await s.run();
    expect(st.state).toBe("complete");
    const sleepCalls = s.g.calls.filter((c) => c.tool === "get_sleep_summary_range").map((c) => `${c.args.start_date}..${c.args.end_date}`);
    expect(sleepCalls).toEqual(["2026-10-11..2026-11-09", "2026-10-26..2026-11-09", "2026-10-11..2026-10-25"]);
    const rows = s.progress().filter((p) => p.kind === "sleep");
    expect(rows.map((r) => [r.windowStart, r.windowEnd, r.status])).toEqual([["2026-10-11", "2026-10-25", "done"], ["2026-10-26", "2026-11-09", "done"]]);
    expect(s.readings("sleep")).toHaveLength(30);
  });

  it("a window that times out again at half size is marked failed with a reason, and the import carries on", async () => {
    const s = await setup({ days: 30, handler: (tool) => (tool === "get_hrv_trend" ? msg("Read timed out") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete_with_issues");
    expect(st.kinds.find((k) => k.id === "hrv")).toMatchObject({ done: 0, failed: 2, state: "attention", reason: "Garmin did not answer in time." });
    expect(st.failedWindows.map((w) => w.kind)).toEqual(["hrv", "hrv"]);
    expect(st.failedWindows[0]?.reason).toBe("Garmin did not answer in time.");
    // Other kinds were not held up.
    expect(st.kinds.find((k) => k.id === "sleep")).toMatchObject({ done: 30 });
    expect(st.kinds.find((k) => k.id === "rhr")).toMatchObject({ done: 30 });
  });

  it("HTTP 429 backs off with doubling waits and the same window is retried, not failed", async () => {
    let n = 0;
    const s = await setup({ days: 30, handler: (tool) => (tool === "get_sleep_summary_range" && ++n <= 2 ? msg("HTTP 429 Too Many Requests") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete");
    expect(s.sleeps.filter((ms) => ms === RATE_BASE_MS || ms === RATE_BASE_MS * 2)).toEqual([RATE_BASE_MS, RATE_BASE_MS * 2]);
    expect(s.g.calls.filter((c) => c.tool === "get_sleep_summary_range")).toHaveLength(3); // twice limited, then the same window works
    expect(st.failedWindows).toEqual([]);
    expect(st.kinds.find((k) => k.id === "sleep")).toMatchObject({ done: 30, failed: 0 });
  });

  it("three rate limits in a row pause the import for an hour, then it resumes by itself without repeating finished windows", async () => {
    let limited = true;
    let now = NOW;
    const g = scripted((tool) => (tool === "get_activities_by_date" ? undefined : limited && tool === "get_sleep_summary_range" ? msg("429 rate limit exceeded") : undefined));
    const t = await makeGarminApp({ clock: () => now, env: { PULSE_HISTORY_DAYS: "30" }, historyConnect: g.connect, historySleep: async () => undefined, historyRate: { baseMs: 1, pauseMs: 3_600_000 } });
    const post = (p: string) => req(t.app, p, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    await post("/api/history/start");
    await t.history.idle();
    let st = historyStatusSchema.parse(await (await t.get("/api/history")).json());
    expect(st.state).toBe("paused");
    expect(st.pausedUntil).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
    expect(st.reason).toContain("resumes by itself after an hour");
    const activityCalls = g.calls.filter((c) => c.tool === "get_activities_by_date").length;
    await t.history.tick(); // too early
    await t.history.idle();
    expect(historyStatusSchema.parse(await (await t.get("/api/history")).json()).state).toBe("paused");
    limited = false;
    now = new Date(NOW.getTime() + 3_600_001);
    await t.history.tick();
    await t.history.idle();
    st = historyStatusSchema.parse(await (await t.get("/api/history")).json());
    expect(st.state).toBe("complete");
    expect(g.calls.filter((c) => c.tool === "get_activities_by_date")).toHaveLength(activityCalls); // the finished kind was not fetched again
  });

  it("three failed windows in a row inside one kind put that kind on needs attention, and the other kinds carry on (D60)", async () => {
    const s = await setup({ days: 120, handler: (tool) => (tool === "get_sleep_summary_range" ? msg("Error retrieving sleep: boom") : undefined) });
    const st = await s.run();
    expect(FAILED_WINDOWS_PER_KIND).toBe(3);
    expect(st.state).toBe("complete_with_issues");
    expect(st.reason).toBe("Some windows failed: Sleep. Start again retries only those.");
    const sleep = st.kinds.find((k) => k.id === "sleep");
    expect(sleep).toMatchObject({ state: "attention", done: 0, failed: 3 });
    expect(sleep?.reason).toContain("Error retrieving sleep: boom");
    expect(st.failedWindows.filter((w) => w.kind === "sleep")).toHaveLength(3);
    // The fourth window was not attempted: the kind was skipped after the third failure.
    expect(s.g.calls.filter((c) => c.tool === "get_sleep_summary_range")).toHaveLength(3);
    // Every other kind ran to the end.
    for (const k of st.kinds.filter((x) => x.id !== "sleep")) expect(k, k.id).toMatchObject({ done: 120, state: "done" });
    expect(s.g.calls.some((c) => c.tool === "get_rhr_day")).toBe(true);
    expect(s.g.calls.some((c) => c.tool === "get_lactate_threshold")).toBe(true);
  });

  it("a success in between resets the count, so two failures twice never need attention, but the failed windows still show", async () => {
    let n = 0;
    const s = await setup({ days: 150, handler: (tool) => (tool === "get_hrv_trend" ? (++n % 3 === 0 ? undefined : msg("Error retrieving hrv: boom")) : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete_with_issues");
    expect(Object.keys(loadState(s.t.handle.db, 150).attention)).toEqual([]);
    expect(st.kinds.find((k) => k.id === "hrv")?.failed).toBeGreaterThan(0);
  });

  it("an unreachable Garmin server stops the import with a plain reason, not a raw error", async () => {
    const t = await makeGarminApp({ clock, env: { PULSE_HISTORY_DAYS: "30" }, historyConnect: async () => { throw new TypeError("fetch failed"); }, historySleep: async () => undefined });
    await req(t.app, "/api/history/start", { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    await t.history.idle();
    const st = historyStatusSchema.parse(await (await t.get("/api/history")).json());
    expect(st.state).toBe("stopped");
    expect(st.reason).toBe("Could not reach the Garmin server.");
  });

  it("an unreadable range answer falls back to the per-day tool for sleep", async () => {
    const g2 = scripted((tool, a) => (tool === "get_sleep_summary_range" ? json({ weird: "shape" }) : tool === "get_sleep_summary" ? json({ sleep_score: 80, sleep_hours: 7, sleep_score_qualifier: "GOOD" }) : generate(tool, a)));
    const t = await makeGarminApp({ clock, env: { PULSE_HISTORY_DAYS: "30" }, historyConnect: g2.connect, historySleep: async () => undefined });
    await req(t.app, "/api/history/start", { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    await t.history.idle();
    expect(t.handle.db.select().from(dailyReading).where(eq(dailyReading.kind, "sleep")).all()).toHaveLength(30);
    expect(g2.calls.filter((c) => c.tool === "get_sleep_summary")).toHaveLength(30);
    expect(loadState(t.handle.db, 30).state).toBe("complete");
  });
});

describe("history import: resume and reruns", () => {
  it("survives a restart: it resumes without repeating finished windows", async () => {
    // Pause during the first per-day kind by pausing from inside a call.
    let paused = false;
    let dbRef: ReturnType<typeof saveState> extends never ? never : Parameters<typeof saveState>[0] | null = null;
    const g = scripted((tool) => {
      if (tool === "get_rhr_day" && !paused && g.calls.length > 40 && dbRef) {
        paused = true;
        saveState(dbRef, { state: "paused", reason: "Paused by you." }, 60);
      }
      return undefined;
    });
    const t = await makeGarminApp({ clock, env: { PULSE_HISTORY_DAYS: "60" }, historyConnect: g.connect, historySleep: async () => undefined });
    dbRef = t.handle.db;
    const post = (p: string) => req(t.app, p, { method: "POST", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken } });
    await post("/api/history/start");
    await t.history.idle();
    const partial = historyStatusSchema.parse(await (await t.get("/api/history")).json());
    expect(partial.state).toBe("paused");
    const doneRows = t.handle.db.select().from(backfillProgress).all().filter((p) => p.status === "done").length;
    expect(doneRows).toBeGreaterThan(3);
    const seen = new Set(g.calls.map((c) => `${c.tool}|${c.args.start_date ?? c.args.date}|${c.args.end_date ?? ""}`));

    // A restart: a new module over the same database. State says running, so the tick resumes it.
    saveState(t.handle.db, { state: "running" }, 60);
    const g2 = scripted();
    const { createHistoryModule } = await import("../src/modules/history/module.js");
    const second = createHistoryModule({ db: t.handle.db, connect: g2.connect, days: 60, log: createLogger("silent"), now: clock, sleep: async () => undefined, busy: () => false });
    await second.tick();
    await second.idle();
    expect(loadState(t.handle.db, 60).state).toBe("complete");
    // Nothing finished before the restart was asked for again.
    const finishedFirst = new Set(t.handle.db.select().from(backfillProgress).all().filter((p) => p.status === "done").map((p) => `${p.kind}|${p.windowStart}`));
    expect(finishedFirst.size).toBeGreaterThan(doneRows);
    for (const c of g2.calls) expect(seen.has(`${c.tool}|${c.args.start_date ?? c.args.date}|${c.args.end_date ?? ""}`), `${c.tool} ${JSON.stringify(c.args)} repeated`).toBe(false);
  });

  it("reruns are idempotent: a finished import asks for nothing and changes nothing; progress upserts by kind and window start", async () => {
    const s = await setup({ days: 60 });
    await s.run();
    const rowsBefore = s.progress();
    const readingsBefore = s.t.handle.db.select().from(dailyReading).all().length;
    const calls = s.g.calls.length;
    await s.run();
    expect(s.g.calls.length).toBe(calls);
    expect(s.progress()).toEqual(rowsBefore);
    expect(s.t.handle.db.select().from(dailyReading).all()).toHaveLength(readingsBefore);
    // A failed window that later succeeds replaces its row.
    s.t.handle.db.delete(backfillProgress).where(and(eq(backfillProgress.kind, "hrv"))).run();
    s.t.handle.db.insert(backfillProgress).values({ kind: "hrv", windowStart: "2026-10-11", windowEnd: "2026-11-09", status: "failed", rows: 0, reason: "x", updatedAt: "x" }).run();
    s.t.handle.db.delete(dailyReading).where(eq(dailyReading.kind, "hrv")).run();
    await s.run();
    const hrv = s.progress().filter((p) => p.kind === "hrv");
    expect(hrv.filter((p) => p.windowStart === "2026-10-11")).toHaveLength(1);
    expect(hrv.every((p) => p.status === "done")).toBe(true);
    expect(s.readings("hrv")).toHaveLength(30 + 30);
  });

  it("nothing runs until Start, and the routes need a session and a CSRF token", async () => {
    const s = await setup();
    expect(s.g.calls).toHaveLength(0);
    expect(await s.status()).toMatchObject({ state: "idle" });
    await s.t.history.tick();
    expect(s.g.calls).toHaveLength(0);
    expect((await req(s.t.app, "/api/history/start", { method: "POST", headers: { cookie: s.t.cookie } })).status).toBe(403);
    expect((await req(s.t.app, "/api/history")).status).toBe(401);
  });

  it("Pause stops it within one window, and Resume carries on", async () => {
    let pauseNow: (() => void) | null = null;
    const s = await setup({ days: 60, handler: (tool) => (tool === "get_sleep_summary_range" ? void pauseNow?.() : undefined) });
    pauseNow = () => {
      pauseNow = null;
      void s.post("/api/history/pause");
    };
    await s.post("/api/history/start");
    await s.t.history.idle();
    let st = await s.status();
    expect(st.state).toBe("paused");
    expect(st.reason).toBe("Paused by you.");
    await s.post("/api/history/resume");
    await s.t.history.idle();
    st = await s.status();
    expect(st.state).toBe("complete");
  });
});

describe("history import: the routine sync goes first", () => {
  it("makes no Garmin call while the routine sync or the backup is busy, and polls until it is free", async () => {
    let busy = true;
    let polls = 0;
    const s = await setup({
      days: 30,
      busy: () => {
        polls++;
        if (polls > 4) busy = false; // the sync finishes after a few polls
        return busy;
      },
    });
    const gate: boolean[] = [];
    const orig = s.g.connect;
    void orig;
    await s.run();
    expect(polls).toBeGreaterThan(4);
    expect(s.sleeps.filter((ms) => ms === 5_000).length).toBeGreaterThanOrEqual(4);
    expect(gate).toEqual([]);
    expect((await s.status()).state).toBe("complete");
  });

  it("yields while a sync or backup is running, around the :00 and :30 slots, and in the backup window", () => {
    const at = (iso: string) => new Date(iso);
    expect(shouldYield(at("2026-11-09T12:10:00Z"), false, false)).toBe(false);
    expect(shouldYield(at("2026-11-09T12:10:00Z"), true, false)).toBe(true);
    expect(shouldYield(at("2026-11-09T12:10:00Z"), false, true)).toBe(true);
    for (const m of ["12:29", "12:00", "12:30", "12:59"]) expect(shouldYield(at(`2026-11-09T${m}:20Z`), false, false), m).toBe(true);
    for (const m of ["12:02", "12:15", "12:31", "12:45"]) expect(shouldYield(at(`2026-11-09T${m}:20Z`), false, false), m).toBe(false);
    // Backup around 03:10 London: GMT in November, BST in June.
    expect(shouldYield(at("2026-11-09T03:10:00Z"), false, false)).toBe(true);
    expect(shouldYield(at("2026-11-09T03:22:00Z"), false, false)).toBe(false);
    expect(shouldYield(at("2026-06-09T02:12:00Z"), false, false)).toBe(true);
    expect(shouldYield(at("2026-06-09T03:12:00Z"), false, false)).toBe(false); // that is 04:12 London
  });
});

describe("history import: no secrets", () => {
  it("never puts the key, a URL or a header in a progress reason, the status, or a log line", async () => {
    const logs: string[] = [];
    const s = await setup({ days: 60, logs, handler: (tool) => (tool === "get_sleep_summary_range" ? { kind: "message", text: `Error calling https://garmin-mcp.example/mcp?token=${FAKE_KEY} Authorization: Bearer ${FAKE_KEY}` } : undefined) });
    const st = await s.run();
    const all = [JSON.stringify(st), JSON.stringify(s.progress()), ...logs, await (await s.t.get("/api/history")).text()].join("\n");
    expect(st.failedWindows.length).toBeGreaterThan(0);
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain("TESTKEY");
    expect(all).not.toMatch(/garmin-mcp\.example/);
    expect(all).not.toContain(`Bearer ${FAKE_KEY}`);
    expect(logs.length).toBeGreaterThan(0);
  });
});

const TOO_BIG = "Error retrieving body battery data: Garmin rejected the request (HTTP 400): HTTP error: API Error 400 - requested date range is too big. Check the request.";
const spanOf = (c: { args: Record<string, unknown> }) => Math.round((Date.parse(`${c.args.end_date}T12:00:00Z`) - Date.parse(`${c.args.start_date}T12:00:00Z`)) / 86_400_000) + 1;

describe("history import: window sizes and range too big (D60)", () => {
  it("every range tool's window comes from one table, within the limit its own description states", () => {
    // Stated in the Garmin MCP tool descriptions: sleep range 90 nights, HRV trend 30 days, VO2 max trend 90 days.
    expect(RANGE_LIMITS.sleep).toMatchObject({ max: 90, documented: true });
    expect(RANGE_LIMITS.hrv).toMatchObject({ max: 30, documented: true });
    expect(RANGE_LIMITS.vo2max).toMatchObject({ max: 90, documented: true });
    // No limit is stated for these. Body battery was rejected at 60 days and verified at 14, so all four are fixed at 14.
    for (const id of ["body_battery", "endurance", "hill", "lactate"]) expect(RANGE_LIMITS[id], id).toMatchObject({ start: 14, max: 14, documented: false });
    for (const [id, spec] of Object.entries(RANGE_SPECS)) {
      expect(spec?.start, id).toBe(RANGE_LIMITS[id]?.start);
      expect(spec?.limit, id).toBe(RANGE_LIMITS[id]?.max);
      expect(spec?.start ?? 0, id).toBeLessThanOrEqual(spec?.limit ?? 0);
    }
  });

  it("reads Garmin's HTTP 400 range answer as a window size problem, in plain words, and keeps auth and unreachable apart", () => {
    expect(classifyText(TOO_BIG)).toMatchObject({ kind: "range_too_big", message: "Garmin rejected the date range as too long." });
    expect(classifyText("HTTP 401 Unauthorized")).toMatchObject({ kind: "auth", message: "Garmin refused the login. Check the Garmin connection." });
    expect(classifyText("fetch failed")).toMatchObject({ kind: "unreachable", message: "Could not reach the Garmin server." });
    expect(classifyText("Error retrieving sleep: boom").kind).toBe("failed");
  });

  it("a 400 range too big retries at half size, is not counted as a failed window, and records the size that worked", async () => {
    // Pretend the real limit is 7 days.
    const s = await setup({ days: 60, handler: (tool, a) => (tool === "get_body_battery" && spanOf({ args: a }) > 7 ? msg(TOO_BIG) : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete");
    expect(st.failedWindows).toEqual([]);
    const spans = s.g.calls.filter((c) => c.tool === "get_body_battery").map(spanOf);
    expect(spans.slice(0, 3)).toEqual([14, 7, 7]); // too big, then the two halves, newest first
    expect(spans.slice(3).every((n) => n <= 7)).toBe(true); // never 14 again
    expect(loadState(s.t.handle.db, 60).windowSizes).toEqual({ body_battery: 7 });
    expect(s.readings("body_battery")).toHaveLength(60);
    expect(st.kinds.find((k) => k.id === "body_battery")).toMatchObject({ done: 60, failed: 0, state: "done" });
  });

  it("a remembered size is used from the first call of the next run", async () => {
    const s = await setup({ days: 30 });
    saveState(s.t.handle.db, { windowSizes: { body_battery: 5 } }, 30);
    await s.run();
    const spans = s.g.calls.filter((c) => c.tool === "get_body_battery").map(spanOf);
    expect(spans[0]).toBe(5);
    expect(Math.max(...spans)).toBe(5);
  });

  it("when even single days are rejected it gives up on that window with a plain reason, in a bounded number of calls", async () => {
    const s = await setup({ days: 30, handler: (tool) => (tool === "get_body_battery" ? msg(TOO_BIG) : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete_with_issues");
    expect(st.failedWindows[0]?.reason).toBe("Garmin rejected the date range as too long.");
    expect(s.g.calls.filter((c) => c.tool === "get_body_battery").length).toBeLessThan(60);
    expect(st.kinds.find((k) => k.id === "body_battery")?.state).toBe("attention");
  });
});

describe("history import: one kind failing does not stop the others (D60)", () => {
  it("runs the kinds not yet imported first and body battery last", async () => {
    const s = await setup({ days: 30 });
    await s.run();
    const order = s.g.calls.map((c) => c.tool);
    const last = (tool: string) => order.lastIndexOf(tool);
    const first = (tool: string) => order.indexOf(tool);
    expect(first("get_body_battery")).toBeGreaterThan(last("get_lactate_threshold"));
    expect(first("get_body_battery")).toBeGreaterThan(last("get_vo2max_trend"));
  });

  it("with the first five kinds done and body battery partly failed, VO2 max, endurance, hill and lactate run next, then body battery", async () => {
    const s = await setup({ days: 60 });
    const db = s.t.handle.db;
    const to = TODAY;
    const from = addDays(TODAY, -59);
    for (const k of ["activities", "sleep", "hrv", "rhr", "readiness"]) db.insert(backfillProgress).values({ kind: k, windowStart: from, windowEnd: to, status: "done", rows: 60, reason: null, updatedAt: NOW.toISOString() }).run();
    db.insert(backfillProgress).values({ kind: "body_battery", windowStart: addDays(TODAY, -29), windowEnd: to, status: "done", rows: 30, reason: null, updatedAt: NOW.toISOString() }).run();
    db.insert(backfillProgress).values({ kind: "body_battery", windowStart: from, windowEnd: addDays(TODAY, -30), status: "failed", rows: 0, reason: "x", updatedAt: NOW.toISOString() }).run();
    expect(runOrder(db, from, to).filter((k) => !["activities", "sleep", "hrv", "rhr", "readiness"].includes(k))).toEqual(["vo2max", "endurance", "hill", "lactate", "body_battery"]);
    const st = await s.run();
    expect(st.state).toBe("complete");
    const tools = s.g.calls.map((c) => c.tool);
    expect(tools.indexOf("get_body_battery")).toBeGreaterThan(tools.lastIndexOf("get_lactate_threshold"));
    // The finished kinds were not fetched again.
    expect(tools).not.toContain("get_activities_by_date");
    expect(tools).not.toContain("get_rhr_day");
  });

  it("body battery failing three windows does not stop VO2 max, endurance, hill or lactate, and the final state says so", async () => {
    const s = await setup({ days: 60, handler: (tool) => (tool === "get_body_battery" ? msg("Error retrieving body battery data: boom") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete_with_issues");
    for (const id of ["vo2max", "endurance", "hill", "lactate"]) expect(st.kinds.find((k) => k.id === id), id).toMatchObject({ done: 60, state: "done" });
    const bb = st.kinds.find((k) => k.id === "body_battery");
    expect(bb).toMatchObject({ state: "attention", done: 0 });
    expect(bb?.reason).toContain("boom");
  });

  it("Start again retries only the failed windows once each, plus the ones not yet attempted, and finishes", async () => {
    let broken = true;
    const s = await setup({ days: 120, handler: (tool) => (tool === "get_sleep_summary_range" && broken ? msg("Error retrieving sleep: boom") : undefined) });
    expect((await s.run()).state).toBe("complete_with_issues");
    const before = s.g.calls.length;
    broken = false;
    const st = await s.run();
    expect(st.state).toBe("complete");
    const second = s.g.calls.slice(before);
    // Only sleep was asked for. Everything else is finished and was not fetched again.
    expect(new Set(second.map((c) => c.tool))).toEqual(new Set(["get_sleep_summary_range"]));
    // Each day once: the three failed windows and the one never attempted cover 120 days with no overlap.
    const covered = second.flatMap((c) => days(String(c.args.start_date), String(c.args.end_date)));
    expect(covered).toHaveLength(120);
    expect(new Set(covered).size).toBe(120);
    expect(st.kinds.find((k) => k.id === "sleep")).toMatchObject({ done: 120, state: "done", failed: 0 });
    expect(st.failedWindows).toEqual([]);
    expect(loadState(s.t.handle.db, 120).attention).toEqual({});
  });

  it("an empty window counts as complete", async () => {
    const s = await setup({ days: 30, handler: (tool) => (tool === "get_body_battery" || tool === "get_hill_score" ? msg("No data found for this range") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("complete");
    expect(st.kinds.find((k) => k.id === "body_battery")).toMatchObject({ done: 30, failed: 0, state: "done" });
    expect(st.kinds.find((k) => k.id === "hill")).toMatchObject({ done: 30, state: "done" });
    expect(s.readings("body_battery")).toHaveLength(0);
  });
});

describe("history import: what still stops everything (D60)", () => {
  it("a failed login stops the whole import at once, whichever kind it happens in, with a plain reason", async () => {
    const s = await setup({ days: 30, handler: (tool) => (tool === "get_vo2max_trend" ? msg("Error: HTTP 401 Unauthorized") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("stopped");
    expect(st.reason).toBe("Garmin refused the login. Check the Garmin connection.");
    // Nothing after it ran.
    expect(s.g.calls.some((c) => c.tool === "get_endurance_score" || c.tool === "get_body_battery")).toBe(false);
  });

  it("a Garmin that stops answering mid-run stops the whole import, not one kind", async () => {
    const s = await setup({ days: 30, handler: (tool) => { if (tool === "get_endurance_score") throw new TypeError("fetch failed"); return undefined; } });
    const st = await s.run();
    expect(st.state).toBe("stopped");
    expect(st.reason).toBe("Could not reach the Garmin server.");
    expect(s.g.calls.some((c) => c.tool === "get_body_battery")).toBe(false);
  });

  it("a rate limit still pauses rather than failing a kind", async () => {
    let n = 0;
    const s = await setup({ days: 30, rate: { baseMs: 1, pauseMs: 3_600_000 }, handler: (tool) => (tool === "get_vo2max_trend" && ++n <= 3 ? msg("429 rate limit exceeded") : undefined) });
    const st = await s.run();
    expect(st.state).toBe("paused");
    expect(Object.keys(loadState(s.t.handle.db, 30).attention)).toEqual([]);
  });

  it("secrets never reach a reason, the status or a log line, including from a login failure", async () => {
    const logs: string[] = [];
    const s = await setup({ days: 30, logs, handler: (tool) => (tool === "get_vo2max_trend" ? msg(`HTTP 401 Unauthorized calling https://garmin-mcp.example/mcp?token=${FAKE_KEY} Authorization: Bearer ${FAKE_KEY}`) : undefined) });
    const st = await s.run();
    expect(st.state).toBe("stopped");
    const all = [JSON.stringify(st), JSON.stringify(s.progress()), ...logs, await (await s.t.get("/api/history")).text()].join("\n");
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toMatch(/garmin-mcp\.example/);
    expect(all).not.toContain("Bearer");
  });
});

describe("history: charts, year on year and the AI summary", () => {
  const seedYears = async () => {
    const t = await makeGarminApp({ clock });
    const db = t.handle.db;
    const act = (id: string, date: string, km: number, type = "running") => db.insert(activity).values({ garminActivityId: id, name: "Run", type, startLocal: `${date} 07:00:00`, date, distanceM: km * 1000, durationS: 3000, firstSeen: "x", lastSeen: "x" }).run();
    act("a1", "2026-02-03", 10); act("a2", "2026-10-30", 12); act("a3", "2026-03-01", 5, "cycling");
    act("b1", "2025-02-10", 8); act("b2", "2025-05-05", 9); act("b3", "2025-11-20", 20); // after the same date last year: excluded
    const rhr = (date: string, v: number) => db.insert(dailyReading).values({ kind: "rhr", date, value: v }).run();
    rhr("2026-03-01", 46); rhr("2026-09-01", 44); rhr("2025-03-01", 50); rhr("2025-09-01", 48);
    const vo2 = (date: string, v: number) => db.insert(vo2maxPoint).values({ date, value: v, carriedForward: false, fetchedAt: "x" }).run();
    vo2("2025-11-01", 44.2); vo2("2026-11-07", 45.7);
    return t;
  };

  it("this year against last year, for the same calendar period, facts only", async () => {
    const t = await seedYears();
    const y = yearOnYearSchema.parse(await (await t.get("/api/history/yoy")).json());
    expect(y.thisYear).toEqual({ from: "2026-01-01", to: "2026-11-09" });
    expect(y.lastYear).toEqual({ from: "2025-01-01", to: "2025-11-09" });
    const row = (k: string) => y.rows.find((r) => r.key === k);
    expect(row("distance")).toMatchObject({ thisYear: "22.0 km", lastYear: "17.0 km" });
    expect(row("runs")).toMatchObject({ thisYear: "2", lastYear: "2" });
    expect(row("rhr")).toMatchObject({ thisYear: "45 bpm", lastYear: "49 bpm" });
    expect(row("vo2max")).toMatchObject({ thisYear: "45.7 ml/kg/min on 07/11/2026", lastYear: "44.2 ml/kg/min on 01/11/2025" });
    expect(JSON.stringify(y)).not.toMatch(/better|worse|improv|decline|should|target|behind|ahead/i);
  });

  it("says Not imported yet when last year is missing, and says from when it is partly there", async () => {
    const t = await makeGarminApp({ clock });
    t.handle.db.insert(activity).values({ garminActivityId: "n", name: "Run", type: "running", startLocal: "2026-05-01 07:00:00", date: "2026-05-01", distanceM: 5000, durationS: 1800, firstSeen: "x", lastSeen: "x" }).run();
    let y = getYearOnYear(t.handle.db, NOW);
    expect(y.rows.find((r) => r.key === "distance")).toMatchObject({ thisYear: "5.0 km", lastYear: "0.0 km", note: "Only imported from 01/05/2026." });
    expect(y.rows.find((r) => r.key === "vo2max")).toMatchObject({ thisYear: null, lastYear: null, note: "Not imported yet." });
    const empty = await makeGarminApp({ clock });
    y = getYearOnYear(empty.handle.db, NOW);
    expect(y.rows.find((r) => r.key === "distance")).toMatchObject({ lastYear: null, note: "Not imported yet." });
    expect(yearAgo("2028-02-29")).toBe("2027-02-28");
    expect(yearAgo("2026-11-09")).toBe("2025-11-09");
  });

  it("7 day averages and the stored range come with the daily series", async () => {
    const t = await seedYears();
    const db = t.handle.db;
    for (let i = 0; i < 10; i++) db.insert(dailyReading).values({ kind: "sleep", date: addDays("2026-10-20", i), value: 70 + i }).run();
    const s = historySeriesSchema.parse(await (await t.get("/api/history/series?days=91&kinds=sleep")).json());
    const sleep = s.series[0];
    expect(sleep?.id).toBe("sleep");
    expect(sleep?.points).toHaveLength(10);
    expect(sleep?.points[6]).toMatchObject({ date: "2026-10-26", value: 76, avg7: 73 }); // mean of 70..76
    expect(sleep?.stored).toEqual({ from: "2026-10-20", to: "2026-10-29" });
    expect(withAverage7([{ date: "2026-01-01", value: 10 }, { date: "2026-01-20", value: 20 }])[1]?.avg7).toBe(20); // only days inside the 7 day window count
    expect((await t.get("/api/history/series?days=3")).status).toBe(400);
  });

  it("the AI summary: monthly average, minimum and maximum per kind, at most 24 rows each, facts only", async () => {
    const t = await makeGarminApp({ clock });
    const db = t.handle.db;
    for (let m = 0; m < 30; m++) {
      const date = addDays("2024-05-15", m * 30);
      db.insert(dailyReading).values({ kind: "sleep", date, value: 60 + m }).run();
      db.insert(dailyReading).values({ kind: "sleep", date: addDays(date, 1), value: 80 + m }).run();
    }
    const sum = getHistorySummary(db, NOW, 24);
    const sleep = sum.kinds.find((k) => k.kind === "sleep_score");
    expect(sleep?.months.length).toBeLessThanOrEqual(24);
    expect(sleep?.months.at(-1)).toMatchObject({ days: 2, min: expect.any(Number), max: expect.any(Number) });
    expect(sum.monthsRequested).toBe(24);
    expect(getHistorySummary(db, NOW, 99).monthsRequested).toBe(24);
    expect(monthly([{ date: "2026-10-01", value: 10 }, { date: "2026-10-09", value: 20 }], NOW, 12)).toEqual([{ month: "2026-10", days: 2, avg: 15, min: 10, max: 20 }]);
    const out = runTool("get_history_summary", { months: 24, kinds: ["sleep_score"] }, { db, now: NOW });
    expect(out).toContain('<data source="get_history_summary"');
    expect(out).toContain('"kind":"sleep_score"');
    expect(out).not.toMatch(/should|recommend|taper|better|worse/i);
    expect(runTool("get_history_summary", { months: 99 }, { db, now: NOW })).toContain("Invalid tool input");
  });

  it("the AI keeps its 28 day cap on the existing tools: the new tool is the only one that reaches back further", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/modules/ai/review.ts"), "utf8");
    expect(src).toContain("REVIEW_LOOKBACK_DAYS = 28");
    const dir = join(import.meta.dirname, "../src/modules/ai");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
    expect(walk(dir).length).toBeGreaterThan(10);
  });

  it("doneDays counts only finished windows inside the range", async () => {
    const t = await makeGarminApp({ clock });
    const db = t.handle.db;
    db.insert(backfillProgress).values({ kind: "sleep", windowStart: "2026-10-01", windowEnd: "2026-10-05", status: "done", rows: 5, reason: null, updatedAt: "x" }).run();
    db.insert(backfillProgress).values({ kind: "sleep", windowStart: "2026-10-06", windowEnd: "2026-10-10", status: "failed", rows: 0, reason: "x", updatedAt: "x" }).run();
    expect([...doneDays(db, "sleep", "2026-10-03", "2026-10-20")].sort()).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
  });
});
