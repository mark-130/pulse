import { z } from "zod";

/**
 * The history import (4c, D51). One-off, read only and resumable. It fetches Garmin history for 730 days by default
 * (PULSE_HISTORY_DAYS), gently, and keeps summaries only: daily readings, trends and activity summaries.
 */
export const HISTORY_DEFAULT_DAYS = 730;

export const HISTORY_KINDS = [
  { id: "activities", label: "Activities", tool: "get_activities_by_date", perDay: false },
  { id: "sleep", label: "Sleep", tool: "get_sleep_summary_range", perDay: false },
  { id: "hrv", label: "HRV", tool: "get_hrv_trend", perDay: false },
  { id: "rhr", label: "Resting heart rate", tool: "get_rhr_day", perDay: true },
  { id: "readiness", label: "Training readiness", tool: "get_training_readiness", perDay: true },
  { id: "body_battery", label: "Body battery", tool: "get_body_battery", perDay: false },
  { id: "vo2max", label: "VO2 max", tool: "get_vo2max_trend", perDay: false },
  { id: "endurance", label: "Endurance score", tool: "get_endurance_score", perDay: false },
  { id: "hill", label: "Hill score", tool: "get_hill_score", perDay: false },
  { id: "lactate", label: "Lactate threshold", tool: "get_lactate_threshold", perDay: false },
] as const;
export type HistoryKindId = (typeof HISTORY_KINDS)[number]["id"];

/** Garmin has no history option for these, so they are not imported. They build up from the day they are first synced. */
export const HISTORY_NOT_IMPORTED = ["Race predictions", "Personal records", "Heart rate zones"] as const;

export const historyStateSchema = z.enum(["idle", "running", "paused", "stopped", "complete"]);
export type HistoryState = z.infer<typeof historyStateSchema>;

export const historyStatusSchema = z.object({
  state: historyStateSchema,
  /** Days the import covers, ending today. */
  days: z.number(),
  from: z.string(),
  to: z.string(),
  startedAt: z.string().nullable(),
  /** An estimate from the speed so far. Null until there is enough progress to say. */
  estimatedFinish: z.string().nullable(),
  /** Set while paused by a rate limit: when it resumes by itself. */
  pausedUntil: z.string().nullable(),
  /** Why it is paused or stopped, in plain words. */
  reason: z.string().nullable(),
  /** The kind being fetched right now, or null. */
  current: z.string().nullable(),
  /** Waiting for the routine sync or the nightly backup. */
  waiting: z.boolean(),
  kinds: z.array(z.object({ id: z.string(), label: z.string(), done: z.number(), total: z.number(), failed: z.number() })),
  failedWindows: z.array(z.object({ kind: z.string(), label: z.string(), from: z.string(), to: z.string(), reason: z.string() })),
  /** Everything fetched, but some windows failed. Start again to retry them. */
  incomplete: z.boolean(),
  /** What Garmin gives no history for. */
  notImported: z.array(z.string()),
});
export type HistoryStatus = z.infer<typeof historyStatusSchema>;

/** Daily readings with a 7 day average, for the Trends charts. */
export const SERIES_KINDS = [
  { id: "sleep", label: "Sleep score", unit: "score" },
  { id: "hrv", label: "HRV", unit: "ms" },
  { id: "rhr", label: "Resting heart rate", unit: "bpm" },
  { id: "readiness", label: "Training readiness", unit: "score" },
  { id: "body_battery", label: "Body battery charged", unit: "" },
] as const;
export type SeriesKindId = (typeof SERIES_KINDS)[number]["id"];

export const seriesPointSchema = z.object({ date: z.string(), value: z.number(), avg7: z.number() });
export const historySeriesSchema = z.object({
  from: z.string(),
  to: z.string(),
  series: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      unit: z.string(),
      points: z.array(seriesPointSchema),
      /** First and last day held for this kind, or null when nothing is stored. */
      stored: z.object({ from: z.string(), to: z.string() }).nullable(),
    }),
  ),
});
export type HistorySeries = z.infer<typeof historySeriesSchema>;

/** Trends range choices: 4 weeks, 3 months, 12 months, 24 months. */
export const TREND_RANGES = [
  { days: 28, label: "4 weeks" },
  { days: 91, label: "3 months" },
  { days: 365, label: "12 months" },
  { days: 730, label: "24 months" },
] as const;

export const yearOnYearSchema = z.object({
  thisYear: z.object({ from: z.string(), to: z.string() }),
  lastYear: z.object({ from: z.string(), to: z.string() }),
  rows: z.array(z.object({ key: z.string(), label: z.string(), thisYear: z.string().nullable(), lastYear: z.string().nullable(), note: z.string().nullable() })),
});
export type YearOnYear = z.infer<typeof yearOnYearSchema>;
