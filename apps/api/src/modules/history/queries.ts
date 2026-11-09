import { and, asc, eq, gte, lte } from "drizzle-orm";
import { HISTORY_KINDS, HISTORY_NOT_IMPORTED, SERIES_KINDS, type HistorySeries, type HistoryStatus, type YearOnYear } from "@pulse/shared";
import { addDays, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { activity, backfillProgress, dailyReading, garminSnapshot, vo2maxPoint } from "../../db/schema.js";
import { READING_KINDS } from "../ai/readings.js";
import { doneDays, loadState, type Live } from "./engine.js";

export interface Point {
  date: string;
  value: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Every stored value of a kind: the imported daily readings, with the routine sync's own snapshots taking priority for the same day. */
export function readingSeries(db: Db, kind: string): Point[] {
  const byDate = new Map<string, number>();
  for (const r of db.select().from(dailyReading).where(eq(dailyReading.kind, kind)).orderBy(asc(dailyReading.date)).all()) byDate.set(r.date, r.value);
  const snap = READING_KINDS.find((k) => k.kind === (kind === "body_battery" ? "bodyBattery" : kind));
  if (snap) {
    for (const r of db.select().from(garminSnapshot).where(eq(garminSnapshot.kind, snap.snapshot)).orderBy(asc(garminSnapshot.date)).all()) {
      const v = snap.pick(r.payload);
      if (v !== null) byDate.set(r.date, v);
    }
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

/** The mean of the points in the 7 calendar days ending on each point's day. */
export function withAverage7(points: Point[]): { date: string; value: number; avg7: number }[] {
  return points.map((p, i) => {
    const from = addDays(p.date, -6);
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && (points[j] as Point).date >= from; j--) {
      sum += (points[j] as Point).value;
      n++;
    }
    return { date: p.date, value: p.value, avg7: round1(sum / n) };
  });
}

export function getSeries(db: Db, now: Date, days: number, kinds?: string[]): HistorySeries {
  const to = londonDate(now);
  const from = addDays(to, -(days - 1));
  const wanted = SERIES_KINDS.filter((k) => !kinds || kinds.includes(k.id));
  return {
    from,
    to,
    series: wanted.map((k) => {
      const all = readingSeries(db, k.id);
      const inRange = all.filter((p) => p.date >= from && p.date <= to);
      return { id: k.id, label: k.label, unit: k.unit, points: withAverage7(inRange), stored: all.length ? { from: (all[0] as Point).date, to: (all.at(-1) as Point).date } : null };
    }),
  };
}

// ---------------------------------------------------------------- import status
const COST_START = 30;

export function getHistoryStatus(db: Db, now: Date, days: number, live: Live): HistoryStatus {
  const st = loadState(db, days);
  const total = st.days > 0 ? st.days : days;
  const to = londonDate(now);
  const from = addDays(to, -(total - 1));
  const rows = db.select().from(backfillProgress).all();
  let doneCost = 0;
  let remainingCost = 0;
  let windowsLeft = 0;
  const failedWindows: HistoryStatus["failedWindows"] = [];
  const kinds = HISTORY_KINDS.map((k) => {
    const done = doneDays(db, k.id, from, to);
    const failed = rows.filter((r) => r.kind === k.id && r.status === "failed" && dayCount(r.windowStart, r.windowEnd).some((d) => !done.has(d)));
    for (const f of failed) failedWindows.push({ kind: k.id, label: k.label, from: f.windowStart, to: f.windowEnd, reason: f.reason ?? "Failed." });
    const cost = k.perDay ? 1 : 1 / COST_START;
    doneCost += done.size * cost;
    remainingCost += (total - done.size) * cost;
    windowsLeft += Math.ceil((total - done.size) / (k.perDay ? 14 : COST_START));
    return { id: k.id, label: k.label, done: done.size, total, failed: failed.length };
  });
  failedWindows.sort((a, b) => b.to.localeCompare(a.to));

  let estimatedFinish: string | null = null;
  if (st.state === "running" && doneCost >= 10 && st.activeMs >= 10_000 && remainingCost > 0) {
    const msPerCost = st.activeMs / doneCost;
    estimatedFinish = new Date(now.getTime() + remainingCost * msPerCost + windowsLeft * 2_000).toISOString();
  }
  const anyFailed = failedWindows.length > 0;
  return {
    state: st.state,
    days: total,
    from,
    to,
    startedAt: st.startedAt,
    estimatedFinish,
    pausedUntil: st.pausedUntil,
    reason: st.reason,
    current: st.state === "running" ? live.current : null,
    waiting: st.state === "running" && live.waiting,
    kinds,
    failedWindows: failedWindows.slice(0, 30),
    incomplete: st.state === "complete" && anyFailed,
    notImported: [...HISTORY_NOT_IMPORTED],
  };
}

function dayCount(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------- this year against last year
/** The same calendar day a year earlier. 29 February becomes 28 February. */
export function yearAgo(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5);
  return `${y}-${md === "02-29" ? "02-28" : md}`;
}

export function getYearOnYear(db: Db, now: Date): YearOnYear {
  const today = londonDate(now);
  const thisFrom = `${today.slice(0, 4)}-01-01`;
  const lastFrom = yearAgo(thisFrom);
  const lastTo = yearAgo(today);

  const period = (from: string, to: string) => {
    const runs = db.select().from(activity).where(and(eq(activity.type, "running"), gte(activity.date, from), lte(activity.date, to))).all();
    const rhr = readingSeries(db, "rhr").filter((p) => p.date >= from && p.date <= to);
    const vo2 = db.select().from(vo2maxPoint).where(lte(vo2maxPoint.date, to)).orderBy(asc(vo2maxPoint.date)).all().at(-1) ?? null;
    return {
      km: runs.reduce((n, a) => n + (a.distanceM ?? 0), 0) / 1000,
      runs: runs.length,
      rhr: rhr.length ? rhr.reduce((n, p) => n + p.value, 0) / rhr.length : null,
      rhrDays: rhr.length,
      vo2: vo2 && vo2.date >= addDays(to, -90) ? vo2 : null,
    };
  };
  const a = period(thisFrom, today);
  const b = period(lastFrom, lastTo);

  const firstActivity = db.select({ d: activity.date }).from(activity).orderBy(asc(activity.date)).limit(1).get()?.d ?? null;
  const firstRhr = readingSeries(db, "rhr")[0]?.date ?? null;
  const importedFrom = (first: string | null, from: string) => (first === null || first > from ? (first === null ? "Not imported yet." : `Only imported from ${dm(first)}.`) : null);
  const actNote = importedFrom(firstActivity, lastFrom);
  const rhrNote = importedFrom(firstRhr, lastFrom);

  const km = (v: number) => `${v.toFixed(1)} km`;
  return {
    thisYear: { from: thisFrom, to: today },
    lastYear: { from: lastFrom, to: lastTo },
    rows: [
      { key: "distance", label: "Running distance", thisYear: km(a.km), lastYear: actNote === "Not imported yet." ? null : km(b.km), note: actNote },
      { key: "runs", label: "Runs", thisYear: String(a.runs), lastYear: actNote === "Not imported yet." ? null : String(b.runs), note: actNote },
      { key: "rhr", label: "Average resting heart rate", thisYear: a.rhr === null ? null : `${round1(a.rhr)} bpm`, lastYear: b.rhr === null ? null : `${round1(b.rhr)} bpm`, note: b.rhr === null ? (rhrNote ?? "No readings in that period.") : rhrNote },
      {
        key: "vo2max",
        label: "VO2 max at the end of the period",
        thisYear: a.vo2 ? `${a.vo2.value} ml/kg/min on ${dm(a.vo2.date)}` : null,
        lastYear: b.vo2 ? `${b.vo2.value} ml/kg/min on ${dm(b.vo2.date)}` : null,
        note: b.vo2 ? null : "Not imported yet.",
      },
    ],
  };
}

// ---------------------------------------------------------------- monthly summary for the AI
export interface MonthRow {
  month: string;
  days: number;
  avg: number;
  min: number;
  max: number;
}

const SUMMARY_KINDS: { id: string; label: string; points: (db: Db) => Point[] }[] = [
  { id: "sleep_score", label: "Sleep score", points: (db) => readingSeries(db, "sleep") },
  { id: "hrv_ms", label: "HRV (ms)", points: (db) => readingSeries(db, "hrv") },
  { id: "resting_hr_bpm", label: "Resting heart rate (bpm)", points: (db) => readingSeries(db, "rhr") },
  { id: "training_readiness", label: "Garmin training readiness", points: (db) => readingSeries(db, "readiness") },
  { id: "body_battery_charged", label: "Body battery charged", points: (db) => readingSeries(db, "body_battery") },
  { id: "vo2max", label: "VO2 max", points: (db) => db.select().from(vo2maxPoint).orderBy(asc(vo2maxPoint.date)).all().map((p) => ({ date: p.date, value: p.value })) },
  { id: "endurance_score", label: "Endurance score (weekly points)", points: (db) => readingSeries(db, "endurance") },
  { id: "hill_score", label: "Hill score", points: (db) => readingSeries(db, "hill") },
  { id: "lactate_threshold_hr_bpm", label: "Lactate threshold heart rate (bpm)", points: (db) => readingSeries(db, "lactate") },
];

export const SUMMARY_MAX_MONTHS = 24;

export function monthly(points: Point[], now: Date, months: number): MonthRow[] {
  const to = londonDate(now);
  const startMonth = addMonths(to.slice(0, 7), -(months - 1));
  const groups = new Map<string, number[]>();
  for (const p of points) {
    const m = p.date.slice(0, 7);
    if (m < startMonth) continue;
    groups.set(m, [...(groups.get(m) ?? []), p.value]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-SUMMARY_MAX_MONTHS)
    .map(([month, v]) => ({ month, days: v.length, avg: round1(v.reduce((n, x) => n + x, 0) / v.length), min: round1(Math.min(...v)), max: round1(Math.max(...v)) }));
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Monthly average, minimum and maximum per kind for up to 24 months, and monthly running totals. Facts only. */
export function getHistorySummary(db: Db, now: Date, months: number, only?: string[]) {
  const n = Math.max(1, Math.min(SUMMARY_MAX_MONTHS, Math.floor(months)));
  const kinds = SUMMARY_KINDS.filter((k) => !only || only.includes(k.id)).map((k) => {
    const pts = k.points(db);
    return { kind: k.id, label: k.label, stored: pts.length ? { from: pts[0]?.date, to: pts.at(-1)?.date } : null, months: monthly(pts, now, n) };
  });
  const runs = db.select().from(activity).where(eq(activity.type, "running")).all();
  const startMonth = addMonths(londonDate(now).slice(0, 7), -(n - 1));
  const byMonth = new Map<string, { m: number; runs: number }>();
  for (const a of runs) {
    const m = a.date.slice(0, 7);
    if (m < startMonth) continue;
    const e = byMonth.get(m) ?? { m: 0, runs: 0 };
    e.m += a.distanceM ?? 0;
    e.runs++;
    byMonth.set(m, e);
  }
  const running = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-SUMMARY_MAX_MONTHS).map(([month, e]) => ({ month, km: round1(e.m / 1000), runs: e.runs }));
  return { monthsRequested: n, kinds, runningByMonth: running, note: "Only months with stored data are listed. A month missing from a kind has no stored data for it." };
}
