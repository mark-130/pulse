import { and, gte, lte, notInArray } from "drizzle-orm";
import type { z } from "zod";
import { addDays, londonDate, normaliseTitle } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { activity, garminSnapshot, race, workout } from "../../db/schema.js";
import { sanitiseError } from "../../notify.js";
import { recordKind } from "./freshness.js";
import type { GarminConnector, GarminReadTool, GarminResult, GarminSession } from "./client.js";
import * as up from "./upstream.js";

export interface SyncTaskResult {
  name: string;
  status: "ok" | "empty" | "failed";
  essential: boolean;
  error?: string;
}

export interface SyncResult {
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

interface Ctx {
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

function applyActivities(data: z.infer<typeof up.activitiesSchema>, ctx: Ctx) {
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

function buildTasks(today: string, backfill: boolean): Task<unknown>[] {
  const day = { date: today };
  const tasks: Task<unknown>[] = [
    {
      name: "scheduled_workouts",
      essential: true,
      tool: "get_scheduled_workouts",
      args: { start_date: addDays(today, -14), end_date: addDays(today, 90) },
      kind: "scheduled_workouts",
      schema: up.scheduledSchema,
      apply: (d, c) => applyWorkouts(d as z.infer<typeof up.scheduledSchema>, c, addDays(today, 90)),
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
      args: { start_date: addDays(today, backfill ? -180 : -14), end_date: today, page_size: 100 },
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
    { name: "vo2max_trend", tool: "get_vo2max_trend", args: { start_date: addDays(today, -83), end_date: today }, kind: "vo2max_trend", schema: up.vo2Schema },
    { name: "endurance_score", tool: "get_endurance_score", args: { start_date: addDays(today, -83), end_date: today }, kind: "endurance_score", schema: up.enduranceSchema },
    { name: "race_predictions", tool: "get_race_predictions", args: {}, kind: "race_predictions", schema: up.racePredictionsSchema },
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

/** One read-only pass over Garmin. Never throws for a single failed call. Throws only if it cannot connect. */
export async function runGarminSync(deps: { db: Db; connect: GarminConnector; now?: () => Date; sleep?: Sleep }): Promise<SyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const today = londonDate(now);
  const ctx: Ctx = { db: deps.db, today, nowIso: now.toISOString() };
  const backfill = deps.db.select({ id: activity.garminActivityId }).from(activity).limit(1).all().length === 0;
  const session = await deps.connect();
  try {
    const tasks: SyncTaskResult[] = [];
    const retry: RetryState = { sleep: deps.sleep ?? realSleep, exhausted: 0 };
    for (const task of buildTasks(today, backfill)) {
      const result = await runTask(session, task, ctx, retry);
      // Each kind records its own outcome, so one failure never hides the kinds that worked.
      recordKind(deps.db, task.name, ctx.nowIso, result.status === "failed" ? (result.error ?? "failed") : null);
      tasks.push(result);
    }
    const failed = tasks.filter((t) => t.status === "failed").length;
    return { ok: failed < tasks.length, partial: failed > 0 && failed < tasks.length, tasks };
  } finally {
    await session.close().catch(() => undefined);
  }
}

