import { SCHEDULE_AHEAD_DAYS, type LeadUp, type LeadUpWeek, type RaceView, type RaceWarning } from "@pulse/shared";
import { addDays, daysBetween, weekStart } from "../../dates.js";
import { CLUSTER_DAYS } from "./logic.js";

/**
 * Race lead-up (D42, D43): what Garmin holds for the weeks before a race, counted from the cache. Facts only.
 * There is no suggested load, no target and no advice here: training content belongs to Mark's coach.
 * Pure, no model, so it is the same with AI off.
 */

export interface LeadWorkout {
  date: string;
  name: string;
  durationS: number | null;
  completed: boolean;
}
export interface LeadActivity {
  date: string;
}

export const LEADUP_WEEKS = 4;
const min = (s: number | null) => (s === null ? null : Math.round(s / 60));
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const isHalfOrLonger = (r: RaceView) => r.raceClass === "half" || r.raceClass === "marathon";

export function buildLeadUp(race: RaceView, others: RaceView[], warnings: RaceWarning[], workouts: LeadWorkout[], activities: LeadActivity[], today: string): LeadUp {
  const raceWs = weekStart(race.date);
  const garminUntil = addDays(today, SCHEDULE_AHEAD_DAYS);
  const thisWs = weekStart(today);
  const weeks: LeadUpWeek[] = [];

  if (!race.past) {
    for (let i = LEADUP_WEEKS - 1; i >= 0; i--) {
      const ws = addDays(raceWs, -7 * i);
      const we = addDays(ws, 6);
      // Weeks that ended before this week, or that start beyond what Garmin shows, are left out: there is nothing to report.
      if (we < thisWs || ws > garminUntil) continue;
      const inWeek = workouts.filter((w) => w.date >= ws && w.date <= we).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
      const longest = [...inWeek].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0))[0];
      let rest = 0;
      for (let d = ws; d <= we && d <= garminUntil; d = addDays(d, 1)) {
        if (!inWeek.some((w) => w.date === d) && !activities.some((a) => a.date === d)) rest++;
      }
      const started = ws <= today;
      const soFar = started ? inWeek.filter((w) => w.date <= today) : [];
      weeks.push({
        weekStart: ws,
        weekEnd: we,
        weeksBefore: i,
        shownUntil: we > garminUntil ? garminUntil : null,
        scheduledCount: inWeek.length,
        scheduledMinutes: Math.round(inWeek.reduce((s, w) => s + (w.durationS ?? 0), 0) / 60),
        longest: longest ? { date: longest.date, name: longest.name, minutes: min(longest.durationS) } : null,
        restDays: rest,
        scheduledSoFar: started ? soFar.length : null,
        completedSoFar: started ? soFar.filter((w) => w.completed).length : null,
        sessions: inWeek.map((w) => ({ date: w.date, name: w.name, minutes: min(w.durationS), completed: w.completed })),
      });
    }
  }

  const raceDayWorkouts = workouts.filter((w) => w.date === race.date).map((w) => ({ name: w.name, minutes: min(w.durationS) }));
  const nearbyRaces = race.past
    ? []
    : others
        .filter((o) => o.eventKey !== race.eventKey && !o.past && Math.abs(daysBetween(race.date, o.date)) <= CLUSTER_DAYS && (isHalfOrLonger(race) || isHalfOrLonger(o)))
        .map((o) => ({ title: o.title, date: o.date, daysApart: Math.abs(daysBetween(race.date, o.date)) }))
        .sort((a, b) => a.date.localeCompare(b.date));

  const flags: LeadUp["flags"] = [];
  if (race.priorityInferred) flags.push({ kind: "priority_not_set", text: "Priority not set." });
  for (const f of race.flags) flags.push({ kind: f.kind, text: f.text });
  for (const n of nearbyRaces) flags.push({ kind: "nearby_race", text: `Another race within ${CLUSTER_DAYS} days: ${n.title} on ${dm(n.date)}, ${n.daysApart} days apart.` });
  for (const w of raceDayWorkouts) flags.push({ kind: "race_day_workout", text: `A workout is scheduled in Garmin on race day: ${w.name}${w.minutes !== null ? `, ${w.minutes} min` : ""}.` });

  return {
    raceKey: race.eventKey,
    title: race.title,
    date: race.date,
    past: race.past,
    daysToGo: race.daysUntil,
    priority: race.priority,
    prioritySet: !race.priorityInferred,
    weeks,
    raceDayWorkouts,
    nearbyRaces,
    flags,
    clashes: warnings.filter((w) => w.raceKeys.includes(race.eventKey)).map((w) => ({ id: w.id, kind: w.kind, severity: w.severity, message: w.message })),
  };
}
