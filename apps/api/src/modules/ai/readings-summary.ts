import { HEALTH_NOTE, READINGS_LABELS, type ReadingsState, type ReadingsSummary, type Signal } from "@pulse/shared";
import { addDays } from "../../dates.js";

/**
 * The daily readings summary (D48). Plain code from the defaults in docs/TRAINING.md (D35). It turns Garmin's readings
 * into one neutral label (Readings: strong, mixed or low) and lists each reading as a fact: the figure, its date and
 * the direction against its baseline or recent average. It is not training advice and the AI never receives the label.
 * The scoring and thresholds are unchanged from the first version of this feature (D35).
 */

export interface Avg {
  avg: number;
  days: number;
}

export interface ReadingsInput {
  today: string;
  readiness: { date: string; score: number | null; level: string | null } | null;
  sleep: { date: string; score: number | null } | null;
  hrv: { date: string; lastNightAvg: number | null; baselineLow: number | null; baselineUpper: number | null } | null;
  restingHr: { date: string; bpm: number | null; sevenDayAvg: number | null } | null;
  bodyBattery: { date: string; highest: number | null; current: number | null } | null;
  load: { date: string; atl: number | null; ctl: number | null; acwr: number | null } | null;
  planned: { name: string; durationS: number | null } | null;
  /** Averages of the days before today, from the daily snapshots. Absent or under 3 days means no direction is shown. */
  averages?: { readiness?: Avg | null; sleep?: Avg | null; bodyBattery?: Avg | null };
}

/** Thresholds. Editable defaults, in one place so the fixtures and TRAINING.md can quote them. */
export const THRESHOLDS = {
  readiness: { okFrom: 60, cautionFrom: 40 },
  sleep: { okFrom: 70, cautionFrom: 50 },
  hrvPoorBelowBaselinePct: 10,
  restingHr: { cautionAbove: 3, poorFrom: 7 },
  bodyBattery: { okFrom: 70, cautionFrom: 40 },
  acwr: { okUpTo: 1.3, cautionUpTo: 1.5 },
  /** A signal dated before yesterday is too old to use. */
  maxAgeDays: 1,
  minKnownSignals: 3,
  /** At least this many earlier days are needed to quote a recent average. */
  minAverageDays: 3,
  /** Within this share of the average counts as in line with it. */
  inLinePct: 5,
} as const;

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const num = (n: number) => String(Math.round(n * 10) / 10);

function sig(name: Signal["name"], status: Signal["status"], text: string): Signal {
  return { name, status, text };
}

function tooOld(date: string, today: string): boolean {
  return date < addDays(today, -THRESHOLDS.maxAgeDays);
}

function unknown(name: Signal["name"], label: string, date: string | null, today: string): Signal {
  return sig(name, "unknown", date && tooOld(date, today) ? `${label} is from ${dm(date)}, too old to use.` : `${label} is missing.`);
}

function band(value: number, okFrom: number, cautionFrom: number): Signal["status"] {
  return value >= okFrom ? "ok" : value >= cautionFrom ? "caution" : "poor";
}

/** ", 7 day average 82: above." for a value against its recent average, or just "." when there is no usable average. */
function against(value: number, a: Avg | null | undefined, unit = ""): string {
  if (!a || a.days < THRESHOLDS.minAverageDays) return ".";
  const inLine = Math.abs(value - a.avg) <= (a.avg * THRESHOLDS.inLinePct) / 100;
  const dir = inLine ? "in line" : value > a.avg ? "above" : "below";
  return `, ${a.days} day average ${num(a.avg)}${unit}: ${dir}.`;
}

export function computeReadingsSummary(i: ReadingsInput): ReadingsSummary {
  const { today } = i;
  const avg = i.averages ?? {};
  const signals: Signal[] = [];

  if (i.readiness && i.readiness.score !== null && !tooOld(i.readiness.date, today)) {
    const lvl = i.readiness.level ? ` (${i.readiness.level.toLowerCase()})` : "";
    const text = `Garmin training readiness ${i.readiness.score} out of 100${lvl} on ${dm(i.readiness.date)}${against(i.readiness.score, avg.readiness)}`;
    signals.push(sig("readiness", band(i.readiness.score, THRESHOLDS.readiness.okFrom, THRESHOLDS.readiness.cautionFrom), text));
  } else signals.push(unknown("readiness", "Garmin training readiness", i.readiness?.date ?? null, today));

  const h = i.hrv;
  if (h && h.lastNightAvg !== null && h.baselineLow !== null && h.baselineUpper !== null && !tooOld(h.date, today)) {
    const base = `HRV ${num(h.lastNightAvg)} ms on ${dm(h.date)}, baseline ${num(h.baselineLow)} to ${num(h.baselineUpper)} ms`;
    if (h.lastNightAvg >= h.baselineLow) signals.push(sig("hrv", "ok", `${base}: ${h.lastNightAvg > h.baselineUpper ? "above" : "within"} baseline.`));
    else {
      const below = ((h.baselineLow - h.lastNightAvg) / h.baselineLow) * 100;
      signals.push(sig("hrv", below > THRESHOLDS.hrvPoorBelowBaselinePct ? "poor" : "caution", `${base}: below baseline, ${num(below)} percent under the low end.`));
    }
  } else signals.push(unknown("hrv", "HRV against baseline", h?.date ?? null, today));

  if (i.sleep && i.sleep.score !== null && !tooOld(i.sleep.date, today)) {
    signals.push(sig("sleep", band(i.sleep.score, THRESHOLDS.sleep.okFrom, THRESHOLDS.sleep.cautionFrom), `Sleep score ${i.sleep.score} on ${dm(i.sleep.date)}${against(i.sleep.score, avg.sleep)}`));
  } else signals.push(unknown("sleep", "Sleep score", i.sleep?.date ?? null, today));

  const r = i.restingHr;
  if (r && r.bpm !== null && r.sevenDayAvg !== null && !tooOld(r.date, today)) {
    const diff = r.bpm - r.sevenDayAvg;
    const status = diff >= THRESHOLDS.restingHr.poorFrom ? "poor" : diff > THRESHOLDS.restingHr.cautionAbove ? "caution" : "ok";
    const dir = Math.abs(diff) < 0.5 ? "level with it" : `${num(Math.abs(diff))} bpm ${diff > 0 ? "above" : "below"}`;
    signals.push(sig("restingHr", status, `Resting heart rate ${num(r.bpm)} bpm on ${dm(r.date)}, 7 day average ${num(r.sevenDayAvg)} bpm: ${dir}.`));
  } else signals.push(unknown("restingHr", "Resting heart rate against its average", r?.date ?? null, today));

  const b = i.bodyBattery;
  const bbValue = b ? (b.highest ?? b.current) : null;
  if (b && bbValue !== null && !tooOld(b.date, today)) {
    const against2 = against(bbValue, avg.bodyBattery).replace("day average", "day average peak");
    signals.push(sig("bodyBattery", band(bbValue, THRESHOLDS.bodyBattery.okFrom, THRESHOLDS.bodyBattery.cautionFrom), `Body battery ${b.highest !== null ? "peaked at" : "is"} ${bbValue} on ${dm(b.date)}${against2}`));
  } else signals.push(unknown("bodyBattery", "Body battery", b?.date ?? null, today));

  const l = i.load;
  const ratio = l ? (l.acwr ?? (l.atl !== null && l.ctl ? l.atl / l.ctl : null)) : null;
  if (l && ratio !== null && !tooOld(l.date, today)) {
    const status = ratio <= THRESHOLDS.acwr.okUpTo ? "ok" : ratio <= THRESHOLDS.acwr.cautionUpTo ? "caution" : "poor";
    const loads = l.atl !== null && l.ctl !== null ? `Acute load ${num(l.atl)} against chronic ${num(l.ctl)}, ratio ${num(ratio)}` : `Acute to chronic load ratio ${num(ratio)}`;
    const dir = ratio > 1.05 ? "acute above chronic" : ratio < 0.95 ? "acute below chronic" : "acute level with chronic";
    signals.push(sig("load", status, `${loads} on ${dm(l.date)}: ${dir}.`));
  } else signals.push(unknown("load", "Recent load", l?.date ?? null, today));

  const known = signals.filter((s) => s.status !== "unknown");
  const poor = known.filter((s) => s.status === "poor").length;
  const points = known.reduce((n, s) => n + (s.status === "poor" ? 2 : s.status === "caution" ? 1 : 0), 0);
  const planned = i.planned;

  // The label depends on the readings only (D49). The scheduled workout is a last line and never changes it.
  // The two lowest outcomes of the original scoring were always treated alike, so they are one label.
  let tier: "strong" | "mixed" | "low";
  if (poor >= 2 || points >= 4) tier = "low";
  else if (points >= 2 || poor >= 1) tier = "mixed";
  else tier = "strong";
  const state: ReadingsState = known.length < THRESHOLDS.minKnownSignals ? "unknown" : tier;

  // Always in the same order, so the list reads as facts and not as a ranking.
  const lines = signals.map((s) => s.text);
  if (state === "unknown") lines.unshift(`Only ${known.length} of ${signals.length} readings are available, so there is no label today.`);
  lines.push(planned ? `Scheduled today in Garmin: ${planned.name}${planned.durationS !== null ? `, ${Math.round(planned.durationS / 60)} min` : ""}.` : "Nothing is scheduled in Garmin today.");

  return { state, label: READINGS_LABELS[state], lines, signals, points, scheduledToday: planned?.name ?? null, healthNote: HEALTH_NOTE };
}

/** Words that mean the question is about illness, pain or injury. Those always get the same reply, whatever the data says. */
const HEALTH_WORDS = /\b(ill|illness|sick|unwell|fever|temperature|flu|covid|infection|cough|chest pain|dizzy|faint|injur\w*|pain\w*|hurts?|sore|strain\w*|sprain\w*|swollen|swelling|pulled|torn|tendon|stress fracture|shin splints?|knee pain)\b/i;

export function mentionsHealthConcern(text: string): boolean {
  return HEALTH_WORDS.test(text);
}

/** The fixed illness, pain and injury reply. Written in code, no model call. Only the reference to the old label was reworded (D48). */
export const HEALTH_ADVICE = "Rest today and see a doctor or physio. I cannot assess illness, pain or injury, so the readings label does not apply. This is not medical advice.";
