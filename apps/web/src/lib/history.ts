import type { HistoryStatus } from "@pulse/shared";
import { formatClockDay, formatDate, formatTime, plural } from "./format";

/** "Sleep: 214 of 730 days". */
export const progressText = (k: HistoryStatus["kinds"][number]): string => `${k.label}: ${k.done} of ${k.total} days`;

/** What the card says about the import, in plain words. */
export function stateLine(s: HistoryStatus): string {
  switch (s.state) {
    case "idle":
      return "Not started.";
    case "running":
      return s.waiting ? "Waiting for the routine sync or the backup to finish." : s.current ? `Running. Fetching ${s.current.toLowerCase()}.` : "Running.";
    case "paused":
      return s.pausedUntil ? `Paused by Garmin's rate limit. It resumes by itself at ${formatClockDay(s.pausedUntil)}.` : "Paused.";
    case "stopped":
      return "Stopped.";
    case "complete":
      return s.incomplete ? `Finished, ${plural(s.failedWindows.length, "window")} failed.` : "Complete.";
  }
}

/** "Start", "Start again", "Retry failed windows", "Pause" or "Resume": the one action that fits the state. */
export function primaryAction(s: HistoryStatus): { label: string; action: "start" | "pause" | "resume" } | null {
  if (s.state === "running") return { label: "Pause", action: "pause" };
  if (s.state === "paused") return { label: "Resume", action: "resume" };
  if (s.state === "stopped") return { label: "Start again", action: "start" };
  if (s.state === "complete") return s.incomplete ? { label: "Retry failed windows", action: "start" } : null;
  return { label: "Start", action: "start" };
}

export const finishText = (s: HistoryStatus): string | null => (s.state === "running" && s.estimatedFinish ? `Estimated finish about ${formatClockDay(s.estimatedFinish)}.` : null);

export const periodText = (from: string, to: string): string => `${formatDate(from)} to ${formatDate(to)}`;
export { formatTime };

/** The mean of the values in the 7 calendar days ending on each point's day. */
export function movingAverage7<T extends { date: string; value: number }>(points: T[]): (T & { avg7: number })[] {
  return points.map((p, i) => {
    const from = new Date(Date.parse(`${p.date}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && (points[j] as T).date >= from; j--) {
      sum += (points[j] as T).value;
      n++;
    }
    return { ...p, avg7: Math.round((sum / n) * 10) / 10 };
  });
}
