import { asc, desc, eq } from "drizzle-orm";
import {
  ENDURANCE_BANDS,
  PREDICTION_DISTANCES,
  RUNNING_RECORDS,
  NEW_RECORD_DAYS,
  MIN_PREDICTION_SPARK_DAYS,
  bandLabel,
  formatDuration,
  paceFromSpeed,
  paceFromTime,
  parseDuration,
  predictionDifference,
  type FitnessResponse,
} from "@pulse/shared";
import type { z } from "zod";
import { addDays, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { garminSnapshot, personalRecord, racePrediction } from "../../db/schema.js";
import * as up from "../garmin/upstream.js";
import { getVo2View, kindStatus } from "../zones/data.js";
import { readingSeries } from "../history/queries.js";

/** The latest successfully stored snapshot of a kind. A failed or stale fetch leaves it as it was, so a card never goes blank. */
function latest<T>(db: Db, kind: string, schema: z.ZodType<T>): { date: string; data: T } | null {
  const row = db.select().from(garminSnapshot).where(eq(garminSnapshot.kind, kind)).orderBy(desc(garminSnapshot.date)).limit(1).get();
  if (!row) return null;
  const p = schema.safeParse(row.payload);
  return p.success ? { date: row.date, data: p.data } : null;
}

/** Garmin's band for a score, from its own thresholds: the highest threshold at or below the score, and the next one up. */
export function enduranceBand(score: number, thresholds: Record<string, number>): { key: string; from: number; to: number | null } | null {
  const ordered = ENDURANCE_BANDS.filter((k) => thresholds[k] !== undefined).map((k) => ({ key: k as string, value: thresholds[k] as number }));
  let hit: { key: string; from: number; to: number | null } | null = null;
  ordered.forEach((t, i) => {
    if (score >= t.value) hit = { key: t.key, from: t.value, to: ordered[i + 1]?.value ?? null };
  });
  return hit;
}

/** At most this many points in a sparkline. A long history is averaged into buckets so the line stays light. */
export const SPARK_MAX_POINTS = 120;

export function downsample(points: { date: string; value: number }[], max = SPARK_MAX_POINTS): { date: string; value: number }[] {
  if (points.length <= max) return points;
  const size = points.length / max;
  return Array.from({ length: max }, (_, i) => {
    const bucket = points.slice(Math.floor(i * size), Math.floor((i + 1) * size) || undefined);
    const last = bucket[bucket.length - 1] as { date: string; value: number };
    return { date: last.date, value: Math.round((bucket.reduce((n, p) => n + p.value, 0) / bucket.length) * 10) / 10 };
  });
}

export function getFitness(db: Db, now: Date): FitnessResponse {
  const today = londonDate(now);

  // ---- race predictions and personal records
  const days = db.select().from(racePrediction).orderBy(asc(racePrediction.date)).all();
  const lastPred = days.at(-1) ?? null;
  const recs = db.select().from(personalRecord).all();
  const recFor = (key: string) => {
    const r = recs.find((x) => x.key === key);
    const seconds = r ? parseDuration(r.value) : null;
    return r && seconds !== null ? { time: r.value, seconds, date: r.date } : null;
  };
  const rows = PREDICTION_DISTANCES.map((d) => {
    const seconds = lastPred?.seconds[d.key] ?? null;
    const record = recFor(d.key);
    return {
      key: d.key,
      label: d.label,
      seconds,
      time: seconds === null ? null : formatDuration(seconds),
      pace: seconds === null ? null : paceFromTime(seconds, d.metres),
      record,
      difference: seconds !== null && record ? predictionDifference(seconds, record.seconds) : null,
      spark: days.length >= MIN_PREDICTION_SPARK_DAYS ? days.flatMap((x) => (x.seconds[d.key] === undefined ? [] : [{ date: x.date, seconds: x.seconds[d.key] as number }])) : [],
    };
  });

  // ---- endurance, hill, lactate threshold
  const e = latest(db, "endurance_score", up.enduranceSchema);
  const eThresholds = e?.data.thresholds ?? null;
  const eScore = e?.data.current_score ?? null;
  const hill = latest(db, "hill", up.hillSchema);
  const lt = latest(db, "lactate_threshold", up.lactateSchema);
  const t = eThresholds ? ENDURANCE_BANDS.filter((k) => eThresholds[k] !== undefined).map((k) => ({ key: k as string, label: bandLabel(k), value: eThresholds[k] as number })) : [];
  const first = t[0]?.value;
  const second = t[1]?.value;

  const records = RUNNING_RECORDS.flatMap((k) => {
    const r = recs.find((x) => x.key === k.key);
    return r ? [{ key: k.key, label: k.label, value: r.value, date: r.date, isNew: r.firstSeen >= addDays(today, -NEW_RECORD_DAYS) }] : [];
  });

  return {
    predictions: { date: lastPred?.garminDate ?? lastPred?.date ?? null, rows, trackingSince: days[0]?.date ?? null, snapshots: days.length, ...kindStatus(db, "race_predictions", now) },
    // The sparkline uses the longest history held, up to 24 months. The 30 day change is still worked out from the last 30 days.
    vo2max: getVo2View(db, now, 730),
    endurance:
      e && eScore !== null
        ? {
            score: eScore,
            date: e.data.current_date ?? e.date,
            classification: e.data.classification ?? null,
            classificationLabel: e.data.classification ? bandLabel(e.data.classification) : null,
            thresholds: t,
            band: eThresholds ? enduranceBand(eScore, eThresholds) : null,
            scale: first !== undefined && second !== undefined && t.length > 1 ? { lo: first - (second - first), hi: t[t.length - 1]?.value ?? first } : null,
            weekly: mergeWeekly(readingSeries(db, "endurance").map((p) => ({ weekStart: p.date, avg: p.value })), e.data.weekly_breakdown.map((w) => ({ weekStart: w.week_start, avg: w.avg_score }))),
            ...kindStatus(db, "endurance_score", now),
          }
        : null,
    hill: hill ? { overall: hill.data.latest_overall_score ?? null, strength: hill.data.latest_strength_score ?? null, endurance: hill.data.latest_endurance_score ?? null, date: hill.data.latest_date ?? hill.date, spark: downsample(hillSpark(db, hill.data)), ...kindStatus(db, "hill", now) } : null,
    lactate: lt
      ? {
          heartRate: lt.data.lactate_threshold_heart_rate_bpm ?? null,
          speedMps: lt.data.lactate_threshold_speed_mps ?? null,
          pace: lt.data.lactate_threshold_speed_mps ? paceFromSpeed(lt.data.lactate_threshold_speed_mps) : null,
          measuredOn: lt.data.speed_hr_date ? lt.data.speed_hr_date.slice(0, 10) : lt.date,
          spark: downsample(lactateSpark(db, lt.data)),
          ...kindStatus(db, "lactate_threshold", now),
        }
      : null,
    records: { items: records, ...kindStatus(db, "personal_records", now) },
  };
}

function mergeWeekly(a: { weekStart: string; avg: number }[], b: { weekStart: string; avg: number }[]): { weekStart: string; avg: number }[] {
  const m = new Map<string, number>();
  for (const w of [...a, ...b]) m.set(w.weekStart, w.avg);
  return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([weekStart, avg]) => ({ weekStart, avg }));
}

/** Hill score history: the imported days, with the latest sync's own daily scores taking priority. */
function hillSpark(db: Db, data: z.infer<typeof up.hillSchema>): { date: string; value: number }[] {
  const m = new Map(readingSeries(db, "hill").map((p) => [p.date, p.value]));
  for (const d of data.daily_scores ?? []) if (d.overall != null) m.set(d.date.slice(0, 10), d.overall);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

/** Lactate threshold heart rate at each measurement, from the imported history and the latest one. */
function lactateSpark(db: Db, data: z.infer<typeof up.lactateSchema>): { date: string; value: number }[] {
  const m = new Map(readingSeries(db, "lactate").map((p) => [p.date, p.value]));
  if (data.lactate_threshold_heart_rate_bpm != null && data.speed_hr_date) m.set(data.speed_hr_date.slice(0, 10), data.lactate_threshold_heart_rate_bpm);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}
