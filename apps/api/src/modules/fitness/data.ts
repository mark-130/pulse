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
    vo2max: getVo2View(db, now, 30),
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
            weekly: [...e.data.weekly_breakdown].sort((a, b) => a.week_start.localeCompare(b.week_start)).map((w) => ({ weekStart: w.week_start, avg: w.avg_score })),
            ...kindStatus(db, "endurance_score", now),
          }
        : null,
    hill: hill ? { overall: hill.data.latest_overall_score ?? null, strength: hill.data.latest_strength_score ?? null, endurance: hill.data.latest_endurance_score ?? null, date: hill.data.latest_date ?? hill.date, ...kindStatus(db, "hill", now) } : null,
    lactate: lt
      ? {
          heartRate: lt.data.lactate_threshold_heart_rate_bpm ?? null,
          speedMps: lt.data.lactate_threshold_speed_mps ?? null,
          pace: lt.data.lactate_threshold_speed_mps ? paceFromSpeed(lt.data.lactate_threshold_speed_mps) : null,
          measuredOn: lt.data.speed_hr_date ? lt.data.speed_hr_date.slice(0, 10) : lt.date,
          ...kindStatus(db, "lactate_threshold", now),
        }
      : null,
    records: { items: records, ...kindStatus(db, "personal_records", now) },
  };
}
