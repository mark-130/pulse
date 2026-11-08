import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { garminSnapshot, workout } from "../../db/schema.js";
import * as up from "../garmin/upstream.js";

/**
 * What the app has recorded about Garmin's schedule over time (D45). Garmin removes a workout from its scheduled list
 * once it is completed, so the current list says nothing about the past. The daily snapshots of the schedule are the
 * only history, and they only exist from the day recording began.
 */
export interface KnownWorkout {
  id: string;
  name: string;
  /** The workout's current date: the date in the workout table if Garmin still lists it, else in the latest snapshot. */
  date: string;
  /** The date in the earliest snapshot that held it. Differs from date when it was moved. */
  firstDate: string;
  durationS: number | null;
  /** Garmin's completed flag, from the table or the latest snapshot. */
  completed: boolean;
  /** Still in Garmin's scheduled list now. */
  listed: boolean;
}

export interface ScheduleHistory {
  /** The first day a schedule snapshot was taken, or null if none. */
  recordingBegan: string | null;
  workouts: KnownWorkout[];
}

export function loadScheduleHistory(db: Db): ScheduleHistory {
  const snaps = db.select().from(garminSnapshot).where(eq(garminSnapshot.kind, "scheduled_workouts")).orderBy(asc(garminSnapshot.date)).all();
  const byId = new Map<string, KnownWorkout>();
  for (const s of snaps) {
    const p = up.scheduledSchema.safeParse(s.payload);
    if (!p.success) continue;
    for (const w of p.data.scheduled_workouts) {
      const id = String(w.scheduled_workout_id);
      const prev = byId.get(id);
      byId.set(id, {
        id,
        name: w.name,
        date: w.date,
        firstDate: prev?.firstDate ?? w.date,
        durationS: w.estimated_duration_seconds == null ? (prev?.durationS ?? null) : Math.round(w.estimated_duration_seconds),
        completed: (w.completed ?? false) || (prev?.completed ?? false),
        listed: false,
      });
    }
  }
  // The table is Garmin's list as of the last sync, so it decides the current date and whether it is still listed.
  for (const r of db.select().from(workout).all()) {
    const prev = byId.get(r.garminScheduledId);
    byId.set(r.garminScheduledId, { id: r.garminScheduledId, name: r.name, date: r.date, firstDate: prev?.firstDate ?? r.date, durationS: r.durationS, completed: r.completed || (prev?.completed ?? false), listed: true });
  }
  return { recordingBegan: snaps[0]?.date ?? null, workouts: [...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)) };
}

/** A move belongs to the week of the workout's current date. Direction is first snapshot date to current date. */
export function movedOf(w: KnownWorkout): { from: string; to: string } | null {
  return w.firstDate !== w.date ? { from: w.firstDate, to: w.date } : null;
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Which days of a week the schedule recording covers. */
export function coverage(history: ScheduleHistory, ws: string, we: string): { state: "full" | "partial" | "none"; from: string | null } {
  const began = history.recordingBegan;
  if (began === null || we < began) return { state: "none", from: null };
  if (ws >= began) return { state: "full", from: ws };
  return { state: "partial", from: began };
}

export function missedNote(history: ScheduleHistory, ws: string, we: string): string | null {
  const c = coverage(history, ws, we);
  if (c.state === "full") return null;
  const began = history.recordingBegan;
  if (c.state === "none") return began ? `Missed sessions cannot be checked for this week because schedule recording began on ${dm(began)}.` : "Missed sessions cannot be checked because schedule recording has not started.";
  return `Missed sessions cannot be checked for ${dm(ws)} to ${dm(addOne(c.from as string))} because schedule recording began on ${dm(c.from as string)}.`;
}
const addOne = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The workout name part of an activity title: Garmin titles runs "<location> - <workout name>". */
export function titleWorkoutPart(title: string): string {
  const i = title.indexOf(" - ");
  return i >= 0 ? title.slice(i + 3) : title;
}

const norm = (s: string): string => s.toLowerCase().replace(/[‘’′`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** True when the scheduled workout's name is inside the activity title (after the location prefix), or the other way round. */
export function nameMatches(activityTitle: string, workoutName: string): boolean {
  const a = norm(titleWorkoutPart(activityTitle));
  const w = norm(workoutName);
  if (a.length < 4 || w.length < 4) return false;
  return a === w || a.includes(w) || w.includes(a);
}

export interface RunLike {
  id: string;
  date: string;
  name: string;
}

export interface MatchResult {
  /** Recorded runs on days the schedule recording covers. */
  checkable: number;
  matched: number;
  /** Recorded runs on days before recording began, which cannot be checked. */
  uncheckable: number;
  /** activity id to the scheduled workout it matched. */
  pairs: Map<string, KnownWorkout>;
}

/**
 * Matches recorded runs to scheduled workouts by date and by the workout name inside the activity title. Garmin does not link an
 * activity to its scheduled workout (checked on the live server: no id or link field in get_activities_by_date or get_activity),
 * so this is a name match. It is reliable when the activity keeps the workout's title and can miss one that was renamed.
 */
export function matchRuns(history: ScheduleHistory, runs: RunLike[]): MatchResult {
  const began = history.recordingBegan;
  const pairs = new Map<string, KnownWorkout>();
  const taken = new Set<string>();
  let checkable = 0;
  let uncheckable = 0;
  for (const r of runs) {
    if (began === null || r.date < began) {
      uncheckable++;
      continue;
    }
    checkable++;
    const hit = history.workouts.find((w) => !taken.has(w.id) && w.date === r.date && nameMatches(r.name, w.name));
    if (hit) {
      pairs.set(r.id, hit);
      taken.add(hit.id);
    }
  }
  return { checkable, matched: pairs.size, uncheckable, pairs };
}

export const MATCH_NOTE = "Garmin does not link a recorded run to its scheduled workout, so runs are matched by date and by the workout name inside the activity title. This is reliable while the title keeps the workout name, and can miss a run that was renamed.";

/** One plain sentence about how many recorded runs were scheduled workouts. Never a comparison with zero. */
export function runsLine(total: number, m: MatchResult, began: string | null): string | null {
  if (total === 0) return null;
  const dmBegan = began ? dm(began) : null;
  const runs = (n: number) => `${n} recorded run${n === 1 ? "" : "s"}`;
  if (m.checkable === 0) return `${runs(total)}. They cannot be matched to scheduled workouts because schedule recording began on ${dmBegan ?? "a later date"}.`;
  const all = m.matched === m.checkable && m.checkable === total;
  const base = all ? (total === 1 ? "The one recorded run was a scheduled workout." : `${total} runs were recorded and all ${total} were scheduled workouts.`) : `${m.matched} of ${m.checkable} ${m.checkable === 1 ? "recorded run" : "recorded runs"} matched a scheduled workout.`;
  return m.uncheckable > 0 ? `${base} ${runs(m.uncheckable)} ${m.uncheckable === 1 ? "falls" : "fall"} before schedule recording began on ${dmBegan}, so ${m.uncheckable === 1 ? "it cannot" : "they cannot"} be matched.` : base;
}
