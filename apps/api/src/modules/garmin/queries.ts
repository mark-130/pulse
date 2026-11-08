import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { z } from "zod";
import type {
  ActivityItem,
  Readiness,
  TodayResponse,
  Verdict,
  TrendsResponse,
  WeekResponse,
  WorkoutItem,
} from "@pulse/shared";
import { addDays, londonDate, weekStart } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { activity, garminSnapshot, workout } from "../../db/schema.js";
import { lastGarminOk } from "./freshness.js";
import { computeVerdict } from "../ai/verdict.js";
import { countPending } from "../proposals/engine.js";
import { getRaceView } from "../races/data.js";
import * as up from "./upstream.js";

/** Reads the database only. Never calls Garmin. */

function latestSnapshot<T>(db: Db, kind: string, schema: z.ZodType<T>, today: string): { date: string; data: T } | null {
  const row = db
    .select()
    .from(garminSnapshot)
    .where(and(eq(garminSnapshot.kind, kind), lte(garminSnapshot.date, today)))
    .orderBy(desc(garminSnapshot.date))
    .limit(1)
    .get();
  if (!row) return null;
  const parsed = schema.safeParse(row.payload);
  return parsed.success ? { date: row.date, data: parsed.data } : null;
}

const toWorkout = (w: typeof workout.$inferSelect): WorkoutItem => ({
  scheduledId: w.garminScheduledId,
  date: w.date,
  name: w.name,
  sport: w.sport,
  durationS: w.durationS,
  completed: w.completed,
});

const toActivity = (a: typeof activity.$inferSelect): ActivityItem => ({
  id: a.garminActivityId,
  name: a.name,
  type: a.type,
  startLocal: a.startLocal,
  date: a.date,
  distanceM: a.distanceM,
  durationS: a.durationS,
  avgHr: a.avgHr,
  maxHr: a.maxHr,
  calories: a.calories,
});

function pickReadiness(db: Db, today: string): Readiness | null {
  const snap = latestSnapshot(db, "training_readiness", up.readinessSchema, today);
  if (!snap) return null;
  const entries = Array.isArray(snap.data) ? snap.data : [snap.data];
  const latest = [...entries].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0];
  if (!latest) return null;
  return {
    date: latest.date,
    score: latest.score ?? null,
    level: latest.level ?? null,
    feedback: latest.feedback ?? null,
    sleepScore: latest.sleep_score ?? null,
    recoveryTimeHours: latest.recovery_time_hours ?? null,
    acuteLoad: latest.acute_load ?? null,
  };
}

function buildVerdict(db: Db, today: string, readiness: Readiness | null, metrics: TodayResponse["metrics"]): Verdict {
  const load = latestSnapshot(db, "training_load_trend", up.trainingLoadTrendSchema, today);
  const last = load?.data.trend[load.data.trend.length - 1];
  const planned = db.select().from(workout).where(and(eq(workout.date, today), eq(workout.completed, false))).orderBy(asc(workout.name)).get();
  return computeVerdict({
    today,
    readiness: readiness ? { date: readiness.date, score: readiness.score, level: readiness.level } : null,
    sleep: metrics.sleep ? { date: metrics.sleep.date, score: metrics.sleep.score } : null,
    hrv: metrics.hrv,
    restingHr: metrics.restingHr,
    bodyBattery: metrics.bodyBattery,
    load: last ? { date: last.date, atl: last.atl ?? null, ctl: last.ctl ?? null, acwr: last.acwr ?? null } : null,
    planned: planned ? { name: planned.name, durationS: planned.durationS } : null,
  });
}

export function getToday(db: Db, now: Date): TodayResponse {
  const today = londonDate(now);
  const sleep = latestSnapshot(db, "sleep", up.sleepSchema, today);
  const hrv = latestSnapshot(db, "hrv", up.hrvSchema, today);
  const rhr = latestSnapshot(db, "rhr", up.rhrSchema, today);
  const stats = latestSnapshot(db, "stats", up.statsSchema, today);
  const bb = latestSnapshot(db, "body_battery", up.bodyBatterySchema, today);
  const rhrValue = rhr?.data.allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE?.[0]?.value ?? stats?.data.resting_heart_rate_bpm ?? null;
  const bbDay = bb?.data[0];
  const races = getRaceView(db, now).races.filter((r) => !r.past);
  const next = db
    .select()
    .from(workout)
    .where(and(gte(workout.date, addDays(today, 1))))
    .orderBy(asc(workout.date))
    .limit(1)
    .get();
  const readiness = pickReadiness(db, today);
  const metrics: TodayResponse["metrics"] = {
      sleep: sleep ? { date: sleep.date, score: sleep.data.sleep_score ?? null, hours: sleep.data.sleep_hours ?? null, qualifier: sleep.data.sleep_score_qualifier ?? null } : null,
      hrv: hrv
        ? {
            date: hrv.date,
            lastNightAvg: hrv.data.last_night_avg_hrv_ms ?? null,
            weeklyAvg: hrv.data.weekly_avg_hrv_ms ?? null,
            baselineLow: hrv.data.baseline_balanced_low_ms ?? null,
            baselineUpper: hrv.data.baseline_balanced_upper_ms ?? null,
            status: hrv.data.status ?? null,
          }
        : null,
      restingHr: rhrValue === null ? null : { date: (rhr ?? stats)?.date ?? today, bpm: rhrValue, sevenDayAvg: stats?.data.last_7_days_avg_resting_hr ?? null },
      bodyBattery: stats
        ? {
            date: stats.date,
            current: stats.data.body_battery_current ?? null,
            highest: stats.data.body_battery_highest ?? null,
            lowest: stats.data.body_battery_lowest ?? null,
            charged: bbDay?.charged ?? stats.data.body_battery_charged ?? null,
            drained: bbDay?.drained ?? stats.data.body_battery_drained ?? null,
          }
        : null,
  };
  return {
    date: today,
    syncedAt: lastGarminOk(db),
    proposals: { pending: countPending(db, now) },
    verdict: buildVerdict(db, today, readiness, metrics),
    readiness,
    session: {
      today: db.select().from(workout).where(eq(workout.date, today)).all().map(toWorkout),
      next: next ? toWorkout(next) : null,
      activitiesToday: db.select().from(activity).where(eq(activity.date, today)).orderBy(asc(activity.startLocal)).all().map(toActivity),
    },
    metrics,
    nextRace: races[0] ?? null,
    followingRace: races[1] ?? null,
  };
}

export function getWeek(db: Db, now: Date, startParam?: string): WeekResponse {
  const today = londonDate(now);
  const start = weekStart(startParam ?? today);
  const end = addDays(start, 6);
  const workouts = db.select().from(workout).where(and(gte(workout.date, start), lte(workout.date, end))).orderBy(asc(workout.date)).all();
  const acts = db.select().from(activity).where(and(gte(activity.date, start), lte(activity.date, end))).orderBy(asc(activity.startLocal)).all();
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    return { date, workouts: workouts.filter((w) => w.date === date).map(toWorkout), activities: acts.filter((a) => a.date === date).map(toActivity) };
  });
  const runs = acts.filter((a) => a.type === "running");
  return {
    start,
    end,
    today,
    syncedAt: lastGarminOk(db, ["plan", "activities"]),
    days,
    totals: { distanceM: runs.reduce((s, a) => s + (a.distanceM ?? 0), 0), durationS: runs.reduce((s, a) => s + (a.durationS ?? 0), 0), runs: runs.length },
  };
}

export function getTrends(db: Db, now: Date): TrendsResponse {
  const today = londonDate(now);
  const load = latestSnapshot(db, "training_load_trend", up.trainingLoadTrendSchema, today);
  const vo2 = latestSnapshot(db, "vo2max_trend", up.vo2Schema, today);
  const endurance = latestSnapshot(db, "endurance_score", up.enduranceSchema, today);
  const preds = latestSnapshot(db, "race_predictions", up.racePredictionsSchema, today);
  const since = addDays(weekStart(today), -7 * 11);
  const runs = db.select().from(activity).where(and(gte(activity.date, since), eq(activity.type, "running"))).all();
  const weeks = new Map<string, { distanceM: number; runs: number }>();
  for (let i = 0; i < 12; i++) weeks.set(addDays(since, i * 7), { distanceM: 0, runs: 0 });
  for (const a of runs) {
    const w = weeks.get(weekStart(a.date));
    if (w) {
      w.distanceM += a.distanceM ?? 0;
      w.runs += 1;
    }
  }
  const labels: Record<string, string> = { "5K": "5K", "10K": "10K", half_marathon: "Half marathon", marathon: "Marathon" };
  return {
    syncedAt: lastGarminOk(db, ["activities", "trends"]),
    trainingLoad: (load?.data.trend ?? []).map((t) => ({ date: t.date, atl: t.atl ?? null, ctl: t.ctl ?? null, acwr: t.acwr ?? null })),
    vo2max: (vo2?.data.trend ?? []).map((t) => ({ date: t.date, value: t.vo2_max })),
    endurance: endurance
      ? { current: endurance.data.current_score ?? null, classification: endurance.data.classification ?? null, weekly: endurance.data.weekly_breakdown.map((w) => ({ weekStart: w.week_start, avg: w.avg_score })) }
      : null,
    weeklyDistance: [...weeks.entries()].map(([weekStartDate, v]) => ({ weekStart: weekStartDate, ...v })),
    racePredictions: preds
      ? {
          date: preds.data.prediction_date,
          items: Object.entries(preds.data.predictions).map(([k, v]) => ({ label: labels[k] ?? k, seconds: v.time_seconds })),
        }
      : null,
  };
}
