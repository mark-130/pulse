import { z } from "zod";
import { vo2ResponseSchema } from "./zones.js";

/**
 * The Fitness screen (D47). Garmin's figures, reported as they are: race predictions, VO2 max, endurance score, hill score,
 * lactate threshold and personal records. NGtive Split does not interpret them (D42).
 */
export const FITNESS_FOOTER = "From Garmin. Pulse reports these figures and does not interpret them.";
export const PREDICTIONS_FOOTNOTE = "Garmin's predictions are estimates based on VO2 max and recent training.";
/** A sparkline per distance needs at least this many daily snapshots. */
export const MIN_PREDICTION_SPARK_DAYS = 7;
/** A personal record first seen in the last 14 days gets a "New" tag. */
export const NEW_RECORD_DAYS = 14;

export const PREDICTION_DISTANCES = [
  { key: "5K", label: "5K", metres: 5000 },
  { key: "10K", label: "10K", metres: 10_000 },
  { key: "half_marathon", label: "Half marathon", metres: 21_097.5 },
  { key: "marathon", label: "Marathon", metres: 42_195 },
] as const;
export type PredictionKey = (typeof PREDICTION_DISTANCES)[number]["key"];

/** Garmin's running record types. Cycling, steps and streak records are not shown. */
export const RUNNING_RECORDS = [
  { type: "Fastest 1K", key: "1k", label: "1K", metres: 1000 },
  { type: "Fastest Mile", key: "mile", label: "Mile", metres: 1609.344 },
  { type: "Fastest 5K", key: "5K", label: "5K", metres: 5000 },
  { type: "Fastest 10K", key: "10K", label: "10K", metres: 10_000 },
  { type: "Fastest Half Marathon", key: "half_marathon", label: "Half marathon", metres: 21_097.5 },
  { type: "Fastest Marathon", key: "marathon", label: "Marathon", metres: 42_195 },
  { type: "Longest Run", key: "longest_run", label: "Longest run", metres: null },
] as const;

/** "m:ss" under an hour, "h:mm:ss" from an hour. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Garmin's own display strings, "23:40" or "1:57:36", back to seconds. Null if it is not a time. */
export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Pace per km as "m:ss /km", from a time and a distance in metres. */
export function paceFromTime(seconds: number, metres: number): string {
  return `${formatDuration(seconds / (metres / 1000))} /km`;
}

/** Pace per km from a speed in metres per second: 3.1388801 m/s is 5:19 /km. */
export function paceFromSpeed(metresPerSecond: number): string | null {
  return metresPerSecond > 0 ? `${formatDuration(1000 / metresPerSecond)} /km` : null;
}

export type Difference = { seconds: number; direction: "faster" | "slower" | "same"; text: string };

/** Garmin's prediction against the record, as a plain fact: "predicted 1:55 faster than the record". */
export function predictionDifference(predicted: number, record: number): Difference {
  const diff = Math.round(predicted) - Math.round(record);
  if (diff === 0) return { seconds: 0, direction: "same", text: "predicted the same as the record" };
  const direction = diff < 0 ? "faster" : "slower";
  return { seconds: Math.abs(diff), direction, text: `predicted ${formatDuration(Math.abs(diff))} ${direction} than the record` };
}

/** The prediction distance a race matches, within 2 percent, or null. */
export function matchPredictionDistance(metres: number | null): (typeof PREDICTION_DISTANCES)[number] | null {
  if (metres === null || metres <= 0) return null;
  return PREDICTION_DISTANCES.find((d) => Math.abs(metres - d.metres) / d.metres <= 0.02) ?? null;
}

export const ENDURANCE_BANDS = ["intermediate", "trained", "well_trained", "expert", "superior", "elite"] as const;
export const bandLabel = (key: string): string => key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

const statusShape = { fetchedAt: z.string().nullable(), ageMinutes: z.number().nullable(), stale: z.boolean(), lastError: z.string().nullable() };

export const fitnessResponseSchema = z.object({
  predictions: z.object({
    date: z.string().nullable(),
    rows: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        seconds: z.number().nullable(),
        time: z.string().nullable(),
        pace: z.string().nullable(),
        record: z.object({ time: z.string(), seconds: z.number(), date: z.string() }).nullable(),
        difference: z.object({ seconds: z.number(), direction: z.enum(["faster", "slower", "same"]), text: z.string() }).nullable(),
        /** Daily snapshots, only once there are seven or more. */
        spark: z.array(z.object({ date: z.string(), seconds: z.number() })),
      }),
    ),
    /** Garmin cannot give past predictions, so the trend starts on the first day the app stored one. */
    trackingSince: z.string().nullable(),
    snapshots: z.number(),
    ...statusShape,
  }),
  vo2max: vo2ResponseSchema,
  endurance: z
    .object({
      score: z.number(),
      date: z.string().nullable(),
      /** Garmin's own label, shown as Garmin's. */
      classification: z.string().nullable(),
      classificationLabel: z.string().nullable(),
      thresholds: z.array(z.object({ key: z.string(), label: z.string(), value: z.number() })),
      /** Garmin's band for the score, worked out from its thresholds: from, up to (exclusive). */
      band: z.object({ key: z.string(), from: z.number(), to: z.number().nullable() }).nullable(),
      scale: z.object({ lo: z.number(), hi: z.number() }).nullable(),
      weekly: z.array(z.object({ weekStart: z.string(), avg: z.number() })),
      ...statusShape,
    })
    .nullable(),
  hill: z.object({ overall: z.number().nullable(), strength: z.number().nullable(), endurance: z.number().nullable(), date: z.string().nullable(), spark: z.array(z.object({ date: z.string(), value: z.number() })).default([]), ...statusShape }).nullable(),
  lactate: z.object({ heartRate: z.number().nullable(), speedMps: z.number().nullable(), pace: z.string().nullable(), measuredOn: z.string().nullable(), spark: z.array(z.object({ date: z.string(), value: z.number() })).default([]), ...statusShape }).nullable(),
  records: z.object({
    items: z.array(z.object({ key: z.string(), label: z.string(), value: z.string(), date: z.string(), isNew: z.boolean() })),
    ...statusShape,
  }),
});
export type FitnessResponse = z.infer<typeof fitnessResponseSchema>;

export const leadUpPredictionSchema = z.object({ distance: z.string(), time: z.string(), date: z.string() });
export type LeadUpPrediction = z.infer<typeof leadUpPredictionSchema>;
