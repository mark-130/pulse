import { and, asc, gte, lte } from "drizzle-orm";
import { SCHEDULE_AHEAD_DAYS, type Review, type ReviewCoverage } from "@pulse/shared";
import { addDays, londonDate, weekStart } from "../../dates.js";
import { activity } from "../../db/schema.js";
import { groupStatuses } from "../garmin/freshness.js";
import { getRaceView } from "../races/data.js";
import { WEEKLY_REVIEW_TASK } from "./prompts.js";
import { systemFor } from "./proposal-tools.js";
import { textFrom } from "./failure.js";
import { loadReadings, readingsCoverage, type Point } from "./readings.js";
import { callModel, type AiRuntime } from "./runtime.js";
import { loadScheduleHistory, matchRuns, MATCH_NOTE, missedNote, movedOf, runsLine as runsLineOf } from "./schedule-history.js";
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
  const r = getStored<{ coversUntil?: string; coverage?: ReviewCoverage }>(rt.db, "weekly_review", week);
  return r ? { week, text: r.text, generatedAt: r.createdAt, model: r.model, coversUntil: r.data.coversUntil ?? week, coverage: r.data.coverage ?? null } : null;
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const firstLast = (pts: Point[]) => (pts.length ? { first: pts[0], last: pts[pts.length - 1], days: pts.length } : null);

/** Pre-assembled context for one review. Facts from the cache only, the last 28 days of readings at most. */
export function reviewContext(rt: AiRuntime, ws: string) {
  const now = rt.now();
  const today = londonDate(now);
  const we = addDays(ws, 6);
  const coversUntil = we < today ? we : today;
  const acts = rt.db.select().from(activity).where(and(gte(activity.date, ws), lte(activity.date, we))).orderBy(asc(activity.startLocal)).all();
  const runs = acts.filter((a) => a.type === "running");

  // Garmin removes a completed workout from its list, so the past is read from the schedule snapshots (D45).
  const history = loadScheduleHistory(rt.db);
  const began = history.recordingBegan;
  const covered = (d: string) => began !== null && d >= began;
  const match = matchRuns(history, runs.map((r) => ({ id: r.garminActivityId, date: r.date, name: r.name })));
  const matchedIds = new Set([...match.pairs.values()].map((w) => w.id));

  const inWeek = history.workouts.filter((w) => w.date >= ws && w.date <= we && covered(w.date));
  const scheduled = inWeek.map((w) => ({
    date: w.date,
    name: w.name,
    scheduledMinutes: mins(w.durationS),
    status: w.completed || matchedIds.has(w.id) ? "done" : w.date < today ? "missed" : "not yet due",
  }));
  const movedThisWeek = history.workouts
    .filter((w) => w.date >= ws && w.date <= we)
    .flatMap((w) => {
      const m = movedOf(w);
      return m ? [{ name: w.name, from: m.from, to: m.to, text: `moved from ${dm(m.from)} to ${dm(m.to)}` }] : [];
    });
  const scheduleNote = missedNote(history, ws, we);
  const runsLine = runsLineOf(runs.length, match, began);

  const nextWs = addDays(ws, 7);
  const nextWorkouts = history.workouts
    .filter((w) => w.date >= nextWs && w.date <= addDays(nextWs, 6) && w.listed)
    .map((w) => {
      const m = movedOf(w);
      return { date: w.date, name: w.name, scheduledMinutes: mins(w.durationS), ...(m ? { moved: `moved from ${dm(m.from)} to ${dm(m.to)}` } : {}) };
    });
  const races = getRaceView(rt.db, now).races.filter((r) => !r.past && r.daysUntil <= 28).slice(0, 3).map((r) => ({ title: r.title, date: r.date, daysUntil: r.daysUntil, priority: r.priorityInferred ? "Priority not set" : r.priority }));

  const readings = loadReadings(rt.db, today);
  const rc = readingsCoverage(readings);
  const staleGroups = (groupStatuses(rt.db, now, STALE_AFTER_MIN) ?? []).filter((g) => g.stale).map((g) => g.label);
  const tail = (k: keyof typeof readings) => ({ daily: readings[k].slice(-14), ...firstLast(readings[k]) });

  return {
    context: {
      today,
      week: { start: ws, end: we, coversUntil },
      staleGroups,
      // scheduledInGarmin only holds days the schedule recording covers. When it is empty for a past week that means no record, not zero.
      scheduledInGarmin: scheduled,
      scheduleNote,
      scheduledMinutes: began === null || we < began ? null : scheduled.reduce((s, x) => s + (x.scheduledMinutes ?? 0), 0),
      movedThisWeek,
      runs: { recorded: runs.length, line: runsLine },
      recordedThisWeek: acts.map((a) => ({ date: a.date, name: a.name, type: a.type, km: km(a.distanceM), minutes: mins(a.durationS), avgHr: a.avgHr, matchedToScheduledWorkout: match.pairs.has(a.garminActivityId) })),
      recordedRunningMinutes: Math.round(runs.reduce((s, a) => s + (a.durationS ?? 0), 0) / 60),
      readiness: tail("readiness"),
      sleepScore: tail("sleep"),
      hrvLastNightMs: tail("hrv"),
      restingHeartRateBpm: tail("restingHr"),
      bodyBatteryCharged: tail("bodyBattery"),
      nextWeek: { start: nextWs, scheduledInGarmin: nextWorkouts, garminShowsUntil: addDays(today, SCHEDULE_AHEAD_DAYS) },
      races,
    },
    coversUntil,
    coverage: { readingsLine: rc.line, scheduleNote, runsLine, matchingNote: runs.length > 0 ? MATCH_NOTE : null },
  };
}

/** Writes the review for the week starting ws unless one is cached. Refresh rewrites it, and costs a call. */
export async function generateReview(rt: AiRuntime, ws: string, refresh = false): Promise<Review> {
  const existing = getReview(rt, ws);
  if (existing && !refresh) return existing;
  const { context, coversUntil, coverage } = reviewContext(rt, ws);
  const model = rt.config.ANTHROPIC_MODEL_SMART;
  const res = await callModel(rt, "review", {
    model,
    system: systemFor(rt.config),
    effort: "low",
    maxTokens: MAX_TOKENS,
    messages: [{ role: "user", content: `${WEEKLY_REVIEW_TASK}\n\nContext:\n${wrapData("weekly_review_context", context)}` }],
  });
  const text = textFrom(res);
  putStored(rt.db, "weekly_review", ws, { text, data: { coversUntil, staleGroups: context.staleGroups, coverage }, model, tokens: res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens, now: rt.now() });
  return getReview(rt, ws) as Review;
}

export const thisWeek = (rt: AiRuntime) => weekStart(londonDate(rt.now()));
