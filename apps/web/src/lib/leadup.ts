import type { LeadUpWeek } from "@pulse/shared";
import { formatDate, formatDayDate, plural } from "./format";

/** "Week of 09/11". */
export const weekTitle = (w: Pick<LeadUpWeek, "weekStart">): string => `Week of ${formatDate(w.weekStart).slice(0, 5)}`;

/** "Race week", "1 week before", "2 weeks before". */
export const weekLabel = (w: Pick<LeadUpWeek, "weeksBefore">): string => (w.weeksBefore === 0 ? "Race week" : `${plural(w.weeksBefore, "week")} before`);

/** What Garmin holds for the week, in plain words. Counts only. */
export function scheduledLine(w: LeadUpWeek): string {
  if (w.scheduledCount === 0) return "Nothing scheduled in Garmin.";
  return `${plural(w.scheduledCount, "workout")} scheduled, ${w.scheduledMinutes} min in total.`;
}

export function longestLine(w: LeadUpWeek): string | null {
  return w.longest ? `Longest: ${w.longest.name}${w.longest.minutes !== null ? `, ${w.longest.minutes} min` : ""}, ${formatDayDate(w.longest.date)}.` : null;
}

/** Completed against scheduled so far, or null for a week that has not started. */
export function progressLine(w: LeadUpWeek): string | null {
  return w.scheduledSoFar === null || w.completedSoFar === null ? null : `${w.completedSoFar} of ${w.scheduledSoFar} scheduled so far completed.`;
}
