import { and, asc, eq, gte, lte } from "drizzle-orm";
import { addDays } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { garminSnapshot } from "../../db/schema.js";
import * as up from "../garmin/upstream.js";

/** How far back the review and the readings backfill look. Never the whole history. */
export const READING_DAYS = 28;

export type ReadingKind = "readiness" | "sleep" | "hrv" | "restingHr" | "bodyBattery";
export interface Point {
  date: string;
  value: number;
}

export const READING_KINDS: { kind: ReadingKind; snapshot: string; pick: (payload: unknown) => number | null }[] = [
  {
    kind: "readiness",
    snapshot: "training_readiness",
    pick: (payload) => {
      const p = up.readinessSchema.safeParse(payload);
      if (!p.success) return null;
      const entries = Array.isArray(p.data) ? p.data : [p.data];
      const latest = [...entries].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))[0];
      return latest?.score ?? null;
    },
  },
  { kind: "sleep", snapshot: "sleep", pick: (payload) => { const p = up.sleepSchema.safeParse(payload); return p.success ? (p.data.sleep_score ?? null) : null; } },
  { kind: "hrv", snapshot: "hrv", pick: (payload) => { const p = up.hrvSchema.safeParse(payload); return p.success ? (p.data.last_night_avg_hrv_ms ?? null) : null; } },
  { kind: "restingHr", snapshot: "rhr", pick: (payload) => { const p = up.rhrSchema.safeParse(payload); return p.success ? (p.data.allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE?.[0]?.value ?? null) : null; } },
  // Body battery: the day's charged amount. The drained amount is in the same snapshot.
  { kind: "bodyBattery", snapshot: "body_battery", pick: (payload) => { const p = up.bodyBatterySchema.safeParse(payload); return p.success ? (p.data[0]?.charged ?? null) : null; } },
];

export const LABELS: Record<ReadingKind, string> = { readiness: "readiness", sleep: "sleep", hrv: "HRV", restingHr: "resting heart rate", bodyBattery: "body battery" };

/** One reading per day for each kind over the last 28 days, from the daily snapshots. */
export function loadReadings(db: Db, today: string): Record<ReadingKind, Point[]> {
  const since = addDays(today, -(READING_DAYS - 1));
  const out = {} as Record<ReadingKind, Point[]>;
  for (const k of READING_KINDS) {
    const rows = db.select().from(garminSnapshot).where(and(eq(garminSnapshot.kind, k.snapshot), gte(garminSnapshot.date, since), lte(garminSnapshot.date, today))).orderBy(asc(garminSnapshot.date)).all();
    out[k.kind] = rows.flatMap((r) => {
      const v = k.pick(r.payload);
      return v === null ? [] : [{ date: r.date, value: v }];
    });
  }
  return out;
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** How many days of readings were used, counted in code. The model never states or estimates this. */
export function readingsCoverage(r: Record<ReadingKind, Point[]>): { counts: Record<ReadingKind, number>; line: string } {
  const counts = Object.fromEntries((Object.keys(LABELS) as ReadingKind[]).map((k) => [k, r[k].length])) as Record<ReadingKind, number>;
  const parts = (Object.keys(LABELS) as ReadingKind[]).map((k) => `${LABELS[k]} ${days(counts[k])}`);
  return { counts, line: `Readings used (of the last ${READING_DAYS} days): ${parts.join(", ")}.` };
}
