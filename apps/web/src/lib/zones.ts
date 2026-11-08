import { validateKotchaTops, type Vo2Point, type ZonesResponse } from "@pulse/shared";

/** "up to 128 bpm" for zone 1, "129 to 143 bpm" for the rest. */
export function rangeText(from: number | null, top: number): string {
  return from === null ? `up to ${top} bpm` : `${from} to ${top} bpm`;
}

export interface BarSpan {
  /** Percent of the scale before the bar starts. */
  left: number;
  /** Percent of the scale the bar covers. */
  width: number;
}

/** A thin bar per zone on one shared scale, from the lowest bpm shown to the max, so widths compare. */
export function barSpans(zones: ZonesResponse["kotcha"]["zones"], garminFloor1: number | null): BarSpan[] {
  const first = zones[0]?.top ?? 0;
  const base = garminFloor1 !== null && garminFloor1 < first ? garminFloor1 : Math.max(0, first - 25);
  const max = zones[zones.length - 1]?.top ?? base + 1;
  const span = Math.max(1, max - base + 1);
  return zones.map((z) => {
    const from = z.from ?? base;
    return { left: Math.max(0, ((from - base) / span) * 100), width: Math.max(2, ((z.top - from + 1) / span) * 100) };
  });
}

/** The edit sheet's text boxes as numbers. Anything that is not a whole number stays as NaN so the check reports it. */
export function parseTops(values: string[]): number[] {
  return values.map((v) => (/^\s*\d+\s*$/.test(v) ? Number(v) : Number.NaN));
}

export function checkTops(values: string[], max: number | null): string[] {
  const r = validateKotchaTops(parseTops(values), max);
  return r.ok ? [] : r.errors;
}

/** Sparkline geometry for the VO2 max card: x by date, y by value, with some padding. */
export function sparkPoints(points: Vo2Point[], width: number, height: number): { x: number; y: number; carried: boolean; value: number }[] {
  if (points.length === 0) return [];
  const t0 = Date.parse(`${points[0]?.date}T12:00:00Z`);
  const t1 = Date.parse(`${points[points.length - 1]?.date}T12:00:00Z`);
  const lo = Math.min(...points.map((p) => p.value));
  const hi = Math.max(...points.map((p) => p.value));
  const pad = 6;
  return points.map((p) => ({
    x: pad + (t1 === t0 ? (width - 2 * pad) / 2 : ((Date.parse(`${p.date}T12:00:00Z`) - t0) / (t1 - t0)) * (width - 2 * pad)),
    y: hi === lo ? height / 2 : pad + (1 - (p.value - lo) / (hi - lo)) * (height - 2 * pad),
    carried: p.carriedForward,
    value: p.value,
  }));
}

export type Vo2Range = { days: number; label: string };

/** 4 weeks and 3 months always, and 12 months only once more than 100 days of history are stored. */
export function vo2Ranges(storedFrom: string | null, today: string): Vo2Range[] {
  const out: Vo2Range[] = [{ days: 28, label: "4 weeks" }, { days: 90, label: "3 months" }];
  if (storedFrom && Date.parse(`${today}T12:00:00Z`) - Date.parse(`${storedFrom}T12:00:00Z`) > 100 * 86_400_000) out.push({ days: 365, label: "12 months" });
  return out;
}

/** The plain note when the chosen range starts before the first stored day. */
export function notImportedNote(rangeDays: number, storedFrom: string | null, today: string): string | null {
  if (!storedFrom) return null;
  const start = new Date(Date.parse(`${today}T12:00:00Z`) - rangeDays * 86_400_000).toISOString().slice(0, 10);
  return start < storedFrom ? `Not imported yet before ${storedFrom.slice(8, 10)}/${storedFrom.slice(5, 7)}/${storedFrom.slice(0, 4)}.` : null;
}
