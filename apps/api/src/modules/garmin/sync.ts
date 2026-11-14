import { and, gte, inArray, lte, notInArray } from "drizzle-orm";
import { RUNNING_RECORDS, BACKFILL_DAYS, BACKFILL_WINDOW_DAYS, SCHEDULE_AHEAD_DAYS, SCHEDULE_LOOKBACK_DAYS } from "@pulse/shared";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { addDays, londonDate, normaliseTitle } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { activity, garminSnapshot, personalRecord, race, racePrediction, settings, syncState, vo2maxPoint, workout } from "../../db/schema.js";
import { chooseProfile } from "../zones/logic.js";
import { recordZonesHistory } from "../zones/data.js";
import { sanitiseError } from "../../notify.js";
import { kindJob, recordKind } from "./freshness.js";
import type { GarminConnector, GarminReadTool, GarminResult, GarminSession } from "./client.js";
import * as up from "./upstream.js";

export interface SyncTaskResult {
  name: string;
  status: "ok" | "empty" | "failed";
  essential: boolean;
  error?: string;
}

/** Pause between backfill windows, so a long first sync does not hammer Garmin. */
export const BACKFILL_PAUSE_MS = 2_000;
const ACTIVITY_MIN_DAYS = 3;
const ACTIVITY_MAX_DAYS = 14;

export interface SyncResult {
  /** First backfill of activities: how many 14 day windows are still waiting, and whether one failed this run. */
  backfill?: { pending: number; doneThisRun: number; failedWindow: string | null };
  /** The 28 day readings backfill (readiness, sleep, HRV, resting heart rate, body battery), same rule as the activities one. */
  readingsBackfill?: { pending: number; doneThisRun: number; failedWindow: string | null };
  /** At least one kind was fetched. A run where some kinds failed is partial, not failed. */
  ok: boolean;
  /** Some kinds failed and some succeeded. */
  partial: boolean;
  tasks: SyncTaskResult[];
}

/** Waits before the first and second retry of a timed out call. */
export const RETRY_WAITS_MS = [10_000, 30_000] as const;
/** After this many calls give up on retries in one run, stop retrying so a dead upstream does not stall the job. */
const MAX_EXHAUSTED_RETRIES = 2;

export function isTimeoutError(text: string): boolean {
  return /timed?[ -]?out|ETIMEDOUT|ECONNRESET/i.test(text);
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

interface RetryState {
  sleep: Sleep;
  exhausted: number;
}

interface Task<T> {
  name: string;
  essential?: boolean;
  tool: GarminReadTool;
  args: Record<string, unknown>;
  /** Snapshot kind. Omit for tasks stored only in their own table. */
  kind?: string;
  schema: z.ZodType<T>;
  apply?: (data: T, ctx: Ctx) => void;
  /** Follow has_more across pages, up to 6 pages. */
  paged?: boolean;
}

export interface Ctx {
  db: Db;
  today: string;
  nowIso: string;
}

function upsertSnapshot(ctx: Ctx, kind: string, date: string, payload: unknown) {
  ctx.db
    .insert(garminSnapshot)
    .values({ kind, date, payload, fetchedAt: ctx.nowIso })
    .onConflictDoUpdate({ target: [garminSnapshot.kind, garminSnapshot.date], set: { payload, fetchedAt: ctx.nowIso } })
    .run();
}

function applyRaces(data: z.infer<typeof up.calendarSchema>, ctx: Ctx, from: string, to: string) {
  const seen: string[] = [];
  for (const e of data.events) {
    const eventKey = e.event_uuid ? e.event_uuid : `${e.date}|${normaliseTitle(e.title)}`;
    seen.push(eventKey);
    const values = {
      eventKey,
      eventUuid: e.event_uuid || null,
      title: e.title,
      date: e.date,
      startTimeLocal: e.start_time_local ?? null,
      timeZone: e.time_zone ?? null,
      distanceM: e.distance_meters ?? null,
      goalTimeSeconds: e.goal_time_seconds ?? null,
      isRace: e.is_race ?? false,
      primaryEvent: e.primary_event ?? false,
      subscribed: e.subscribed ?? false,
      location: e.location ?? null,
      url: e.url ?? null,
      active: true,
      lastSeen: ctx.nowIso,
    };
    ctx.db
      .insert(race)
      .values({ ...values, firstSeen: ctx.nowIso })
      .onConflictDoUpdate({ target: race.eventKey, set: values })
      .run();
  }
  // Events Garmin no longer returns inside the window are kept but marked inactive.
  const inWindow = and(gte(race.date, from), lte(race.date, to));
  ctx.db
    .update(race)
    .set({ active: false })
    .where(seen.length ? and(inWindow, notInArray(race.eventKey, seen)) : inWindow)
    .run();
}

function applyWorkouts(data: z.infer<typeof up.scheduledSchema>, ctx: Ctx, to: string) {
  const seen: string[] = [];
  for (const w of data.scheduled_workouts) {
    const id = String(w.scheduled_workout_id);
    seen.push(id);
    const values = {
      garminWorkoutId: w.workout_id == null ? null : String(w.workout_id),
      date: w.date,
      name: w.name,
      sport: w.sport ?? null,
      durationS: w.estimated_duration_seconds == null ? null : Math.round(w.estimated_duration_seconds),
      completed: w.completed ?? false,
      lastSeen: ctx.nowIso,
    };
    ctx.db
      .insert(workout)
      .values({ garminScheduledId: id, ...values, firstSeen: ctx.nowIso })
      .onConflictDoUpdate({ target: workout.garminScheduledId, set: values })
      .run();
  }
  // A future workout that Garmin no longer returns was removed or moved out of view. Past rows are history and stay.
  const future = and(gte(workout.date, ctx.today), lte(workout.date, to));
  ctx.db.delete(workout).where(seen.length ? and(future, notInArray(workout.garminScheduledId, seen)) : future).run();
}

export function applyActivities(data: z.infer<typeof up.activitiesSchema>, ctx: Ctx) {
  for (const a of data.activities) {
    const values = {
      name: a.name,
      type: a.type,
      startLocal: a.start_time,
      date: a.start_time.slice(0, 10),
      distanceM: a.distance_meters ?? null,
      durationS: a.duration_seconds ?? null,
      avgHr: a.avg_hr_bpm == null ? null : Math.round(a.avg_hr_bpm),
      maxHr: a.max_hr_bpm == null ? null : Math.round(a.max_hr_bpm),
      calories: a.calories == null ? null : Math.round(a.calories),
      elevationGainM: a.elevation_gain_meters ?? null,
      lastSeen: ctx.nowIso,
    };
    ctx.db
      .insert(activity)
      .values({ garminActivityId: String(a.id), ...values, firstSeen: ctx.nowIso })
      .onConflictDoUpdate({ target: activity.garminActivityId, set: values })
      .run();
  }
}

/** Keeps the first prediction of the day. A second sync on the same day changes nothing, so a day is always one row. */
function applyPredictions(data: z.infer<typeof up.racePredictionsSchema>, ctx: Ctx) {
  const seconds = Object.fromEntries(Object.entries(data.predictions).map(([k, v]) => [k, v.time_seconds]));
  ctx.db.insert(racePrediction).values({ date: ctx.today, seconds, garminDate: data.prediction_date, fetchedAt: ctx.nowIso }).onConflictDoNothing().run();
}

/**
 * Garmin's running records, with the day each value was first seen. A record that is new or changed gets today's date. The very first
 * import uses each record's own date, so records set long ago are not tagged "New".
 */
function applyRecords(data: z.infer<typeof up.personalRecordsSchema>, ctx: Ctx) {
  const first = ctx.db.select({ id: personalRecord.typeId }).from(personalRecord).limit(1).all().length === 0;
  for (const r of data) {
    const kind = RUNNING_RECORDS.find((k) => k.type === r.record_type);
    if (!kind) continue;
    const prev = ctx.db.select().from(personalRecord).where(eq(personalRecord.typeId, r.type_id)).get();
    if (prev && prev.value === r.value && prev.date === r.date) continue;
    const values = { key: kind.key, recordType: r.record_type, value: r.value, rawValue: r.raw_value ?? null, date: r.date, firstSeen: first ? r.date : ctx.today, updatedAt: ctx.nowIso };
    ctx.db.insert(personalRecord).values({ typeId: r.type_id, ...values }).onConflictDoUpdate({ target: personalRecord.typeId, set: values }).run();
  }
}

export function applyVo2(data: z.infer<typeof up.vo2Schema>, ctx: Ctx) {
  for (const p of data.trend) {
    const values = { value: p.vo2_max, carriedForward: p.carried_forward ?? false, fetchedAt: ctx.nowIso };
    ctx.db.insert(vo2maxPoint).values({ date: p.date, ...values }).onConflictDoUpdate({ target: vo2maxPoint.date, set: values }).run();
  }
}

function buildTasks(today: string, activityDays: number): Task<unknown>[] {
  const day = { date: today };
  const tasks: Task<unknown>[] = [
    {
      name: "scheduled_workouts",
      essential: true,
      tool: "get_scheduled_workouts",
      args: { start_date: addDays(today, -SCHEDULE_LOOKBACK_DAYS), end_date: addDays(today, SCHEDULE_AHEAD_DAYS) },
      kind: "scheduled_workouts",
      schema: up.scheduledSchema,
      apply: (d, c) => applyWorkouts(d as z.infer<typeof up.scheduledSchema>, c, addDays(today, SCHEDULE_AHEAD_DAYS)),
    },
    {
      name: "calendar_events",
      essential: true,
      tool: "get_calendar_events",
      args: { start_date: addDays(today, -14), end_date: addDays(today, 730) },
      kind: "calendar_events",
      schema: up.calendarSchema,
      apply: (d, c) => applyRaces(d as z.infer<typeof up.calendarSchema>, c, addDays(today, -14), addDays(today, 730)),
    },
    {
      name: "activities",
      essential: true,
      paged: true,
      tool: "get_activities_by_date",
      args: { start_date: addDays(today, -activityDays), end_date: today, page_size: 100 },
      schema: up.activitiesSchema,
      apply: (d, c) => applyActivities(d as z.infer<typeof up.activitiesSchema>, c),
    },
    { name: "stats", tool: "get_stats", args: day, kind: "stats", schema: up.statsSchema },
    { name: "training_readiness", tool: "get_training_readiness", args: day, kind: "training_readiness", schema: up.readinessSchema },
    { name: "morning_readiness", tool: "get_morning_training_readiness", args: day, kind: "morning_readiness", schema: up.readinessSchema },
    { name: "sleep", tool: "get_sleep_summary", args: day, kind: "sleep", schema: up.sleepSchema },
    { name: "hrv", tool: "get_hrv_data", args: day, kind: "hrv", schema: up.hrvSchema },
    { name: "rhr", tool: "get_rhr_day", args: day, kind: "rhr", schema: up.rhrSchema },
    { name: "body_battery", tool: "get_body_battery", args: { start_date: today, end_date: today }, kind: "body_battery", schema: up.bodyBatterySchema },
    { name: "training_status", tool: "get_training_status", args: day, kind: "training_status", schema: up.trainingStatusLoose },
    { name: "training_load_balance", tool: "get_training_load_balance", args: day, kind: "training_load_balance", schema: up.trainingStatusLoose },
    {
      name: "training_load_trend",
      tool: "get_training_load_trend",
      args: { start_date: addDays(today, -41), end_date: today },
      kind: "training_load_trend",
      schema: up.trainingLoadTrendSchema,
    },
    // One call of 90 days, the most Garmin allows. It fills the VO2 max table: 30 days for the card, 3 months for Trends. The history import (4c) will add older windows of 30 days.
    {
      name: "vo2max",
      tool: "get_vo2max_trend",
      args: { start_date: addDays(today, -89), end_date: today },
      kind: "vo2max",
      schema: up.vo2Schema,
      apply: (d, c) => applyVo2(d as z.infer<typeof up.vo2Schema>, c),
    },
    { name: "endurance_score", tool: "get_endurance_score", args: { start_date: addDays(today, -83), end_date: today }, kind: "endurance_score", schema: up.enduranceSchema },
    // The prediction is current only: Garmin cannot give past ones. The first successful sync of each day keeps one row (D47).
    { name: "race_predictions", tool: "get_race_predictions", args: {}, kind: "race_predictions", schema: up.racePredictionsSchema, apply: (d, c) => applyPredictions(d as z.infer<typeof up.racePredictionsSchema>, c) },
    { name: "hill", tool: "get_hill_score", args: { start_date: addDays(today, -29), end_date: today }, kind: "hill", schema: up.hillSchema },
    { name: "lactate_threshold", tool: "get_lactate_threshold", args: {}, kind: "lactate_threshold", schema: up.lactateSchema },
    { name: "personal_records", tool: "get_personal_record", args: {}, kind: "personal_records", schema: up.personalRecordsSchema, apply: (d, c) => applyRecords(d as z.infer<typeof up.personalRecordsSchema>, c) },
  ];
  return tasks;
}

/** One call, retried up to twice if it fails with a timeout-type error. */
async function callWithRetry(session: GarminSession, tool: GarminReadTool, args: Record<string, unknown>, retry: RetryState): Promise<GarminResult> {
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const res = await session.call(tool, args);
      if (res.kind !== "message" || /^no\b/i.test(res.text.trim()) || !isTimeoutError(res.text)) return res;
      failure = res.text;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!isTimeoutError(text)) throw err;
      failure = text;
    }
    const wait = RETRY_WAITS_MS[attempt];
    if (wait === undefined || retry.exhausted >= MAX_EXHAUSTED_RETRIES) {
      if (wait === undefined) retry.exhausted++;
      return { kind: "message", text: failure };
    }
    await retry.sleep(wait);
  }
}

async function runTask(session: GarminSession, task: Task<unknown>, ctx: Ctx, retry: RetryState): Promise<SyncTaskResult> {
  const base = { name: task.name, essential: task.essential ?? false };
  try {
    let any = false;
    for (let page = 0; page < (task.paged ? 6 : 1); page++) {
      const res = await callWithRetry(session, task.tool, task.paged ? { ...task.args, page } : task.args, retry);
      if (res.kind === "message") {
        // The Garmin MCP server reports some upstream errors as plain text, not as a tool error.
        if (/^no\b/i.test(res.text.trim())) break;
        return { ...base, status: "failed", error: sanitiseError(res.text) };
      }
      const parsed = task.schema.safeParse(res.data);
      if (!parsed.success) return { ...base, status: "failed", error: `unexpected shape: ${parsed.error.issues[0]?.path.join(".") ?? "?"}` };
      any = true;
      ctx.db.transaction(() => {
        if (task.kind) upsertSnapshot(ctx, task.kind, ctx.today, res.data);
        task.apply?.(parsed.data, ctx);
      });
      const more = task.paged && typeof res.data === "object" && res.data !== null && "has_more" in res.data && res.data.has_more === true;
      if (!more) break;
    }
    return { ...base, status: any ? "ok" : "empty" };
  } catch (err) {
    return { ...base, status: "failed", error: sanitiseError(err) };
  }
}

interface BackfillWindow {
  from: string;
  to: string;
  done: boolean;
}

const BACKFILL_KEY = "garmin_backfill";

/**
 * The 180 day first backfill, in 14 day windows, newest first. The windows are fixed when the backfill starts and
 * stored in settings, so a window that failed is retried on the next run without redoing the others.
 * A database that already has activities from before this rule counts as backfilled.
 */
function loadBackfill(db: Db, today: string): BackfillWindow[] {
  const row = db.select().from(settings).where(eq(settings.key, BACKFILL_KEY)).get();
  if (row) return (row.value as { windows: BackfillWindow[] }).windows;
  const hasActivities = db.select({ id: activity.garminActivityId }).from(activity).limit(1).all().length > 0;
  const windows: BackfillWindow[] = [];
  if (!hasActivities) {
    for (let i = 0; i * BACKFILL_WINDOW_DAYS < BACKFILL_DAYS; i++) {
      const to = addDays(today, -i * BACKFILL_WINDOW_DAYS);
      windows.push({ from: addDays(to, -(BACKFILL_WINDOW_DAYS - 1)), to, done: false });
    }
  }
  saveBackfill(db, windows);
  return windows;
}

function saveBackfill(db: Db, windows: BackfillWindow[]): void {
  db.insert(settings).values({ key: BACKFILL_KEY, value: { windows } }).onConflictDoUpdate({ target: settings.key, set: { value: { windows } } }).run();
}

async function runBackfill(session: GarminSession, windows: BackfillWindow[], ctx: Ctx, retry: RetryState): Promise<NonNullable<SyncResult["backfill"]>> {
  let doneThisRun = 0;
  let failedWindow: string | null = null;
  for (const w of windows) {
    if (w.done) continue;
    if (doneThisRun > 0) await retry.sleep(BACKFILL_PAUSE_MS);
    const task: Task<unknown> = {
      name: "activities_backfill",
      tool: "get_activities_by_date",
      args: { start_date: w.from, end_date: w.to, page_size: 100 },
      paged: true,
      schema: up.activitiesSchema,
      apply: (d, c) => applyActivities(d as z.infer<typeof up.activitiesSchema>, c),
    };
    const result = await runTask(session, task, ctx, retry);
    if (result.status === "failed") {
      // Stop for this run. The window stays not done and is tried again on the next run.
      failedWindow = `${w.from} to ${w.to}`;
      break;
    }
    w.done = true;
    doneThisRun++;
    saveBackfill(ctx.db, windows);
  }
  return { pending: windows.filter((w) => !w.done).length, doneThisRun, failedWindow };
}

/** Routine activity window: 3 days, widened to cover a gap since the last good activities sync, at most 14 days. */
function activityDays(db: Db, now: Date): number {
  const last = db.select().from(syncState).where(eq(syncState.job, kindJob("activities"))).get()?.lastOk;
  if (!last) return ACTIVITY_MAX_DAYS;
  const gap = Math.ceil((now.getTime() - Date.parse(last)) / 86_400_000) + 1;
  return Math.min(ACTIVITY_MAX_DAYS, Math.max(ACTIVITY_MIN_DAYS, gap));
}

// ---------------------------------------------------------------- readings backfill (D45)
/** How many days of readings are kept for the review and filled in at the start. */
export const READINGS_BACKFILL_DAYS = 28;
/** Per-day kinds run at most two calls at a time. */
export const READINGS_CONCURRENCY = 2;
/** Windows a run may finish. A long gap is worked through over several runs, not in one burst (D74). */
export const READINGS_WINDOWS_PER_RUN = 2;
/** A day this recent (today, yesterday, the day before) that Garmin has no data for is asked for again on later runs (D74). */
export const READINGS_RECENT_DAYS = 3;
/** After a recent "no data" answer a reading is not asked for again for this long (D75). The sync runs every 30 minutes. */
export const READINGS_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const READINGS_KEY = "garmin_readings_backfill";

const READING_TASKS = [
  { kind: "training_readiness", tool: "get_training_readiness", schema: up.readinessSchema },
  { kind: "sleep", tool: "get_sleep_summary", schema: up.sleepSchema },
  { kind: "hrv", tool: "get_hrv_data", schema: up.hrvSchema },
  { kind: "rhr", tool: "get_rhr_day", schema: up.rhrSchema },
] as const;

interface ReadingsState {
  windows: BackfillWindow[];
  /** Days Garmin returned nothing for, per kind, so they are not asked again every run. */
  empty: Record<string, string[]>;
  /** The newest day windows have been made for (D74). Absent on a state from before D74: see loadReadingsState. */
  through?: string;
  /** Earliest time (UTC ISO) a recent no-data reading may be asked for again, keyed "kind|date" (D75). Absent on older states. */
  retryAfter?: Record<string, string>;
}

/**
 * The readings windows. The first run makes the last 28 days. Every later run makes windows for the days since the newest one
 * made, up to yesterday (today is the routine pass's own), so a day missed in an outage is picked up by the next run that
 * works. Windows are newest first, at most READINGS_WINDOWS_PER_RUN finish per run, and days already stored or known empty are
 * skipped when a window runs, so a long gap costs calls only for the days that are actually missing.
 */
function loadReadingsState(db: Db, today: string): ReadingsState {
  const row = db.select().from(settings).where(eq(settings.key, READINGS_KEY)).get();
  if (!row) {
    const windows = makeWindows(addDays(today, -(READINGS_BACKFILL_DAYS - 1)), today);
    const state: ReadingsState = { windows, empty: {}, through: today };
    saveReadingsState(db, state);
    return state;
  }
  const state = row.value as ReadingsState;
  const yesterday = addDays(today, -1);
  const through = state.through ?? (state.windows.length > 0 ? state.windows.reduce((m, w) => (w.to > m ? w.to : m), "") : yesterday);
  if (through >= yesterday) {
    if (state.through === undefined) {
      state.through = through;
      saveReadingsState(db, state);
    }
    return state;
  }
  state.windows = [...makeWindows(addDays(through, 1), yesterday), ...state.windows.filter((w) => !w.done)];
  state.through = yesterday;
  saveReadingsState(db, state);
  return state;
}

/** 14 day windows covering from..to, newest first. */
function makeWindows(from: string, to: string): BackfillWindow[] {
  const windows: BackfillWindow[] = [];
  for (let end = to; end >= from; end = addDays(end, -BACKFILL_WINDOW_DAYS)) windows.push({ from: addDays(end, -(BACKFILL_WINDOW_DAYS - 1)) < from ? from : addDays(end, -(BACKFILL_WINDOW_DAYS - 1)), to: end, done: false });
  return windows;
}

function saveReadingsState(db: Db, state: ReadingsState): void {
  db.insert(settings).values({ key: READINGS_KEY, value: state }).onConflictDoUpdate({ target: settings.key, set: { value: state } }).run();
}

function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Runs the jobs with at most `limit` in flight. Every job runs even if another fails. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Fills in the last 28 days of readings (readiness, sleep, HRV, resting heart rate, body battery), reads only and summaries only.
 * 14 day windows, newest first, one at a time with a pause, per-day kinds two calls at a time. A window with a failed call
 * stops the backfill for this run and is tried again at the next run: days already stored are not fetched again.
 */
async function runReadingsBackfill(session: GarminSession, state: ReadingsState, ctx: Ctx, retry: RetryState): Promise<NonNullable<SyncResult["readingsBackfill"]>> {
  let doneThisRun = 0;
  let ran = 0;
  let failedWindow: string | null = null;
  const kinds = [...READING_TASKS.map((t) => t.kind), "body_battery"];
  const recentFrom = addDays(ctx.today, -(READINGS_RECENT_DAYS - 1));
  for (const w of state.windows) {
    if (w.done) continue;
    if (doneThisRun >= READINGS_WINDOWS_PER_RUN) break;
    const have = new Set(ctx.db.select({ kind: garminSnapshot.kind, date: garminSnapshot.date }).from(garminSnapshot).where(and(inArray(garminSnapshot.kind, kinds), gte(garminSnapshot.date, w.from), lte(garminSnapshot.date, w.to))).all().map((r) => `${r.kind}|${r.date}`));
    const isEmpty = (kind: string, d: string) => state.empty[kind]?.includes(d) ?? false;
    // A "no data" answer for the last few days is not final: the watch may not have synced yet (D74). Those days are not recorded as
    // empty and the window stays open, so the next run asks again. Older days are recorded as empty, as before.
    let held = false;
    const retryAfter = (state.retryAfter ??= {});
    const nowMs = Date.parse(ctx.nowIso);
    const cooling = (kind: string, d: string) => {
      const until = retryAfter[`${kind}|${d}`];
      return until !== undefined && Date.parse(until) > nowMs;
    };
    const markEmpty = (kind: string, d: string) => {
      if (d >= recentFrom) {
        held = true;
        retryAfter[`${kind}|${d}`] = new Date(nowMs + READINGS_RETRY_COOLDOWN_MS).toISOString();
      } else {
        state.empty[kind] = [...(state.empty[kind] ?? []), d];
        delete retryAfter[`${kind}|${d}`];
      }
    };
    const stored = (kind: string, d: string, data: unknown) => {
      upsertSnapshot(ctx, kind, d, data);
      delete retryAfter[`${kind}|${d}`];
    };
    let failed = false;

    // Days still cooling down after a recent no-data answer are not asked for (D75). Each kind and day cools on its own.
    const wanted = READING_TASKS.flatMap((t) => daysIn(w.from, w.to).filter((d) => !have.has(`${t.kind}|${d}`) && !isEmpty(t.kind, d)).map((d) => ({ t, d })));
    const jobs = wanted.filter(({ t, d }) => !cooling(t.kind, d));
    const bbOpen = daysIn(w.from, w.to).filter((d) => !have.has(`body_battery|${d}`) && !isEmpty("body_battery", d));
    const missingBb = bbOpen.filter((d) => !cooling("body_battery", d));
    const waiting = wanted.length - jobs.length + bbOpen.length - missingBb.length > 0;
    if (waiting) held = true;
    if (jobs.length === 0 && missingBb.length === 0 && waiting) {
      // Nothing to ask Garmin for: everything missing is cooling down. The window stays open, with no call and no pause.
      continue;
    }
    if (ran++ > 0) await retry.sleep(BACKFILL_PAUSE_MS);

    await pool(jobs, READINGS_CONCURRENCY, async ({ t, d }) => {
      try {
        const res = await callWithRetry(session, t.tool, { date: d }, retry);
        if (res.kind === "message") {
          if (/^no\b/i.test(res.text.trim())) markEmpty(t.kind, d);
          else failed = true;
          return;
        }
        if (!t.schema.safeParse(res.data).success) return markEmpty(t.kind, d);
        stored(t.kind, d, res.data);
      } catch {
        failed = true;
      }
    });

    // Body battery is one ranged call for the window. Its days are stored one snapshot each, in the same one entry array shape.
    // A day still cooling down is not a reason to call, but if the call is made for other days its data is stored too.
    if (missingBb.length > 0) {
      try {
        const res = await callWithRetry(session, "get_body_battery", { start_date: w.from, end_date: w.to }, retry);
        if (res.kind === "message") {
          if (/^no\b/i.test(res.text.trim())) for (const d of missingBb) markEmpty("body_battery", d);
          else failed = true;
        } else {
          const parsed = up.bodyBatterySchema.safeParse(res.data);
          if (!parsed.success) for (const d of missingBb) markEmpty("body_battery", d);
          else {
            for (const d of bbOpen) {
              const entry = parsed.data.find((e) => e.date === d);
              if (entry) stored("body_battery", d, [entry]);
              else if (!cooling("body_battery", d)) markEmpty("body_battery", d);
            }
          }
        }
      } catch {
        failed = true;
      }
    }

    if (failed) {
      failedWindow = `${w.from} to ${w.to}`;
      saveReadingsState(ctx.db, state);
      break;
    }
    if (held) {
      saveReadingsState(ctx.db, state);
      continue;
    }
    w.done = true;
    doneThisRun++;
    saveReadingsState(ctx.db, state);
  }
  return { pending: state.windows.filter((x) => !x.done).length, doneThisRun, failedWindow };
}

/**
 * Heart rate zones (D46): ask for the running profile first and fall back to the DEFAULT profile when none is configured.
 * Garmin answers "No configured heart-rate zones found for sport RUNNING." as plain text, which means there is none.
 * The chosen zones are stored as a summary snapshot, and the history table notes the date a new set was first seen.
 */
async function runZonesTask(session: GarminSession, ctx: Ctx, retry: RetryState): Promise<SyncTaskResult> {
  const base = { name: "hr_zones", essential: false };
  try {
    let res = await callWithRetry(session, "get_heart_rate_zones", { sport: "running" }, retry);
    let zones = res.kind === "json" ? chooseProfile(res.data) : null;
    if (res.kind === "message" && !/^no\b/i.test(res.text.trim())) return { ...base, status: "failed", error: sanitiseError(res.text) };
    if (!zones) {
      // No running profile: the DEFAULT profile applies to running.
      res = await callWithRetry(session, "get_heart_rate_zones", {}, retry);
      if (res.kind === "message") return /^no\b/i.test(res.text.trim()) ? { ...base, status: "empty" } : { ...base, status: "failed", error: sanitiseError(res.text) };
      zones = chooseProfile(res.data);
    }
    if (!zones) return { ...base, status: "failed", error: "unexpected shape: heart rate zones" };
    const chosen = zones;
    ctx.db.transaction(() => {
      upsertSnapshot(ctx, "hr_zones", ctx.today, chosen);
      recordZonesHistory(ctx.db, chosen, ctx.today);
    });
    return { ...base, status: "ok" };
  } catch (err) {
    return { ...base, status: "failed", error: sanitiseError(err) };
  }
}

/** One read-only pass over Garmin. Never throws for a single failed call. Throws only if it cannot connect. */
export async function runGarminSync(deps: { db: Db; connect: GarminConnector; now?: () => Date; sleep?: Sleep }): Promise<SyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const today = londonDate(now);
  const ctx: Ctx = { db: deps.db, today, nowIso: now.toISOString() };
  // Decided before the routine tasks store any activity, or a first run would look like an old database.
  const windows = loadBackfill(deps.db, today);
  const readingsState = loadReadingsState(deps.db, today);
  const days = activityDays(deps.db, now);
  const session = await deps.connect();
  try {
    const tasks: SyncTaskResult[] = [];
    const retry: RetryState = { sleep: deps.sleep ?? realSleep, exhausted: 0 };
    for (const task of buildTasks(today, days)) {
      const result = await runTask(session, task, ctx, retry);
      // Each kind records its own outcome, so one failure never hides the kinds that worked.
      recordKind(deps.db, task.name, ctx.nowIso, result.status === "failed" ? (result.error ?? "failed") : null);
      tasks.push(result);
    }
    const zonesResult = await runZonesTask(session, ctx, retry);
    recordKind(deps.db, "hr_zones", ctx.nowIso, zonesResult.status === "failed" ? (zonesResult.error ?? "failed") : null);
    tasks.push(zonesResult);
    const failed = tasks.filter((t) => t.status === "failed").length;
    // The backfill runs last and never makes the run partial: a failed window is simply tried again next run.
    const backfill = await runBackfill(session, windows, ctx, retry);
    const readingsBackfill = await runReadingsBackfill(session, readingsState, ctx, retry);
    return { ok: failed < tasks.length, partial: failed > 0 && failed < tasks.length, tasks, backfill, readingsBackfill };
  } finally {
    await session.close().catch(() => undefined);
  }
}

