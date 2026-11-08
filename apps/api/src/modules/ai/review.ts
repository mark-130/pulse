import { and, asc, eq, gte, lte } from "drizzle-orm";
import { SCHEDULE_AHEAD_DAYS, type Review } from "@pulse/shared";
import { addDays, londonDate, weekStart } from "../../dates.js";
import { activity, garminSnapshot, proposal as proposalTable, workout } from "../../db/schema.js";
import { groupStatuses } from "../garmin/freshness.js";
import * as up from "../garmin/upstream.js";
import { getRaceView } from "../races/data.js";
import { WEEKLY_REVIEW_TASK } from "./prompts.js";
import { systemFor } from "./proposal-tools.js";
import { textFrom } from "./failure.js";
import { callModel, type AiRuntime } from "./runtime.js";
import { getStored, putStored } from "./store.js";
import { wrapData } from "./tools.js";

/** The review never looks further back than this, however long the history is. */
export const REVIEW_LOOKBACK_DAYS = 28;
const STALE_AFTER_MIN = 90;
/** Room for thinking as well as the text: the models count thinking against this limit (D44). */
const MAX_TOKENS = 4000;

const mins = (s: number | null) => (s === null ? null : Math.round(s / 60));
const km = (m: number | null) => (m === null ? null : Math.round(m / 100) / 10);

export function getReview(rt: AiRuntime, week: string): Review | null {
  const r = getStored<{ coversUntil?: string }>(rt.db, "weekly_review", week);
  return r ? { week, text: r.text, generatedAt: r.createdAt, model: r.model, coversUntil: r.data.coversUntil ?? week } : null;
}

type Point = { date: string; value: number };

/** One reading per day from the daily snapshots. Cached data only, capped to the lookback. */
function readingByDate(rt: AiRuntime, kind: string, since: string, today: string, pick: (payload: unknown) => number | null): Point[] {
  const rows = rt.db.select().from(garminSnapshot).where(and(eq(garminSnapshot.kind, kind), gte(garminSnapshot.date, since), lte(garminSnapshot.date, today))).orderBy(asc(garminSnapshot.date)).all();
  const out: Point[] = [];
  for (const row of rows) {
    const v = pick(row.payload);
    if (v !== null) out.push({ date: row.date, value: v });
  }
  return out;
}

const readinessOf = (payload: unknown): number | null => {
  const p = up.readinessSchema.safeParse(payload);
  if (!p.success) return null;
  const entries = Array.isArray(p.data) ? p.data : [p.data];
  const latest = [...entries].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0];
  return latest?.score ?? null;
};
const sleepOf = (payload: unknown): number | null => {
  const p = up.sleepSchema.safeParse(payload);
  return p.success ? (p.data.sleep_score ?? null) : null;
};
const hrvOf = (payload: unknown): number | null => {
  const p = up.hrvSchema.safeParse(payload);
  return p.success ? (p.data.last_night_avg_hrv_ms ?? null) : null;
};

const firstLast = (pts: Point[]) => (pts.length ? { first: pts[0], last: pts[pts.length - 1], days: pts.length } : null);

/**
 * Workouts whose date changed between daily snapshots of the Garmin schedule, so Mark's coach or the plan app moved them.
 * Only moves seen by the app can be reported: the app keeps one schedule snapshot per sync day.
 */
export function movedWorkouts(rt: AiRuntime, ws: string, we: string, today: string): { name: string; from: string; to: string }[] {
  const rows = rt.db.select().from(garminSnapshot).where(and(eq(garminSnapshot.kind, "scheduled_workouts"), gte(garminSnapshot.date, addDays(today, -REVIEW_LOOKBACK_DAYS)), lte(garminSnapshot.date, today))).orderBy(asc(garminSnapshot.date)).all();
  const seen = new Map<string, { name: string; dates: string[] }>();
  for (const row of rows) {
    const p = up.scheduledSchema.safeParse(row.payload);
    if (!p.success) continue;
    for (const w of p.data.scheduled_workouts) {
      const id = String(w.scheduled_workout_id);
      const e = seen.get(id) ?? { name: w.name, dates: [] };
      if (e.dates[e.dates.length - 1] !== w.date) e.dates.push(w.date);
      seen.set(id, e);
    }
  }
  const moved: { name: string; from: string; to: string }[] = [];
  for (const e of seen.values()) {
    if (e.dates.length < 2) continue;
    const from = e.dates[0] as string;
    const to = e.dates[e.dates.length - 1] as string;
    if (from !== to && ((from >= ws && from <= we) || (to >= ws && to <= we))) moved.push({ name: e.name, from, to });
  }
  // Moves made through this app (a confirmed reschedule) are in the proposal table too.
  for (const p of rt.db.select().from(proposalTable).where(eq(proposalTable.status, "applied")).all()) {
    if (p.kind !== "garmin.reschedule" || !p.decidedAt) continue;
    const before = p.before as { name: string; date: string } | null;
    const after = p.after as { date: string } | null;
    if (before && after && p.decidedAt.slice(0, 10) >= ws && p.decidedAt.slice(0, 10) <= we && !moved.some((m) => m.name === before.name && m.from === before.date)) moved.push({ name: before.name, from: before.date, to: after.date });
  }
  return moved.sort((a, b) => a.from.localeCompare(b.from));
}

/** Pre-assembled context for one review. Facts from the cache only, the last 28 days at most. */
export function reviewContext(rt: AiRuntime, ws: string) {
  const now = rt.now();
  const today = londonDate(now);
  const we = addDays(ws, 6);
  const coversUntil = we < today ? we : today;
  const since = addDays(today, -REVIEW_LOOKBACK_DAYS);
  const acts = rt.db.select().from(activity).where(and(gte(activity.date, ws), lte(activity.date, we))).orderBy(asc(activity.startLocal)).all();
  const runs = acts.filter((a) => a.type === "running");

  const planned = rt.db.select().from(workout).where(and(gte(workout.date, ws), lte(workout.date, we))).orderBy(asc(workout.date)).all();
  const scheduled = planned.map((w) => {
    const sameDay = runs.filter((a) => a.date === w.date);
    // Garmin's completed flag, or a run that day that lasted at least 70 percent of the scheduled time.
    const done = w.completed || (w.durationS !== null && sameDay.some((a) => (a.durationS ?? 0) >= w.durationS! * 0.7));
    return { date: w.date, name: w.name, scheduledMinutes: mins(w.durationS), status: done ? "done" : w.date < today ? "missed" : "not yet due" };
  });

  const nextWs = addDays(ws, 7);
  const nextScheduled = rt.db.select().from(workout).where(and(gte(workout.date, nextWs), lte(workout.date, addDays(nextWs, 6)))).orderBy(asc(workout.date)).all().map((w) => ({ date: w.date, name: w.name, scheduledMinutes: mins(w.durationS) }));
  const races = getRaceView(rt.db, now).races.filter((r) => !r.past && r.daysUntil <= 28).slice(0, 3).map((r) => ({ title: r.title, date: r.date, daysUntil: r.daysUntil, priority: r.priorityInferred ? "Priority not set" : r.priority }));

  const readiness = readingByDate(rt, "training_readiness", since, today, readinessOf);
  const sleep = readingByDate(rt, "sleep", since, today, sleepOf);
  const hrv = readingByDate(rt, "hrv", since, today, hrvOf);
  const staleGroups = (groupStatuses(rt.db, now, STALE_AFTER_MIN) ?? []).filter((g) => g.stale).map((g) => g.label);

  return {
    context: {
      today,
      week: { start: ws, end: we, coversUntil },
      staleGroups,
      scheduledInGarmin: scheduled,
      movedWorkouts: movedWorkouts(rt, ws, we, today),
      totals: { scheduledMinutes: scheduled.reduce((s, x) => s + (x.scheduledMinutes ?? 0), 0), recordedRunningMinutes: Math.round(runs.reduce((s, a) => s + (a.durationS ?? 0), 0) / 60), recordedRuns: runs.length },
      recordedThisWeek: acts.map((a) => ({ date: a.date, name: a.name, type: a.type, km: km(a.distanceM), minutes: mins(a.durationS), avgHr: a.avgHr })),
      readiness: { daily: readiness.slice(-14), ...firstLast(readiness) },
      sleepScore: { daily: sleep.slice(-14), ...firstLast(sleep) },
      hrvLastNightMs: { daily: hrv.slice(-14), ...firstLast(hrv) },
      nextWeek: { start: nextWs, scheduledInGarmin: nextScheduled, garminShowsUntil: addDays(today, SCHEDULE_AHEAD_DAYS) },
      races,
    },
    coversUntil,
  };
}

/** Writes the review for the week starting ws unless one is cached. Refresh rewrites it, and costs a call. */
export async function generateReview(rt: AiRuntime, ws: string, refresh = false): Promise<Review> {
  const existing = getReview(rt, ws);
  if (existing && !refresh) return existing;
  const { context, coversUntil } = reviewContext(rt, ws);
  const model = rt.config.ANTHROPIC_MODEL_SMART;
  const res = await callModel(rt, "review", {
    model,
    system: systemFor(rt.config),
    effort: "low",
    maxTokens: MAX_TOKENS,
    messages: [{ role: "user", content: `${WEEKLY_REVIEW_TASK}\n\nContext:\n${wrapData("weekly_review_context", context)}` }],
  });
  const text = textFrom(res);
  putStored(rt.db, "weekly_review", ws, { text, data: { coversUntil, staleGroups: context.staleGroups }, model, tokens: res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens, now: rt.now() });
  return getReview(rt, ws) as Review;
}

export const thisWeek = (rt: AiRuntime) => weekStart(londonDate(rt.now()));
