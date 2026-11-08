import { HEALTH_NOTE, VERDICT_LABELS, type Signal, type Verdict, type VerdictState } from "@pulse/shared";
import { DEMANDING_NAME } from "../training.js";
import { addDays } from "../../dates.js";

/**
 * The daily readiness verdict. Plain code from the defaults in docs/TRAINING.md (Daily readiness verdict, D35).
 * The AI never decides it. Advice only, not medical guidance.
 */

export interface VerdictInput {
  today: string;
  readiness: { date: string; score: number | null; level: string | null } | null;
  sleep: { date: string; score: number | null } | null;
  hrv: { date: string; lastNightAvg: number | null; baselineLow: number | null; baselineUpper: number | null } | null;
  restingHr: { date: string; bpm: number | null; sevenDayAvg: number | null } | null;
  bodyBattery: { date: string; highest: number | null; current: number | null } | null;
  load: { date: string; atl: number | null; ctl: number | null; acwr: number | null } | null;
  planned: { name: string; durationS: number | null } | null;
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
  demandingMinutes: 90,
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

export function computeVerdict(i: VerdictInput): Verdict {
  const { today } = i;
  const signals: Signal[] = [];

  if (i.readiness && i.readiness.score !== null && !tooOld(i.readiness.date, today)) {
    const lvl = i.readiness.level ? ` (${i.readiness.level.toLowerCase()})` : "";
    signals.push(sig("readiness", band(i.readiness.score, THRESHOLDS.readiness.okFrom, THRESHOLDS.readiness.cautionFrom), `Garmin training readiness ${i.readiness.score} out of 100${lvl} on ${dm(i.readiness.date)}.`));
  } else signals.push(unknown("readiness", "Garmin training readiness", i.readiness?.date ?? null, today));

  if (i.sleep && i.sleep.score !== null && !tooOld(i.sleep.date, today)) {
    signals.push(sig("sleep", band(i.sleep.score, THRESHOLDS.sleep.okFrom, THRESHOLDS.sleep.cautionFrom), `Sleep score ${i.sleep.score} on ${dm(i.sleep.date)}.`));
  } else signals.push(unknown("sleep", "Sleep score", i.sleep?.date ?? null, today));

  const h = i.hrv;
  if (h && h.lastNightAvg !== null && h.baselineLow !== null && h.baselineUpper !== null && !tooOld(h.date, today)) {
    const base = `HRV ${num(h.lastNightAvg)} ms on ${dm(h.date)}, baseline ${num(h.baselineLow)} to ${num(h.baselineUpper)} ms`;
    if (h.lastNightAvg >= h.baselineLow) signals.push(sig("hrv", "ok", `${base}: ${h.lastNightAvg > h.baselineUpper ? "above" : "within"} baseline.`));
    else {
      const below = ((h.baselineLow - h.lastNightAvg) / h.baselineLow) * 100;
      signals.push(sig("hrv", below > THRESHOLDS.hrvPoorBelowBaselinePct ? "poor" : "caution", `${base}: ${num(below)} percent below the low end.`));
    }
  } else signals.push(unknown("hrv", "HRV against baseline", h?.date ?? null, today));

  const r = i.restingHr;
  if (r && r.bpm !== null && r.sevenDayAvg !== null && !tooOld(r.date, today)) {
    const diff = r.bpm - r.sevenDayAvg;
    const status = diff >= THRESHOLDS.restingHr.poorFrom ? "poor" : diff > THRESHOLDS.restingHr.cautionAbove ? "caution" : "ok";
    signals.push(sig("restingHr", status, `Resting heart rate ${num(r.bpm)} bpm on ${dm(r.date)}, 7 day average ${num(r.sevenDayAvg)} bpm.`));
  } else signals.push(unknown("restingHr", "Resting heart rate against its average", r?.date ?? null, today));

  const b = i.bodyBattery;
  const bbValue = b ? (b.highest ?? b.current) : null;
  if (b && bbValue !== null && !tooOld(b.date, today)) {
    signals.push(sig("bodyBattery", band(bbValue, THRESHOLDS.bodyBattery.okFrom, THRESHOLDS.bodyBattery.cautionFrom), `Body battery ${b.highest !== null ? "peaked at" : "is"} ${bbValue} on ${dm(b.date)}.`));
  } else signals.push(unknown("bodyBattery", "Body battery", b?.date ?? null, today));

  const l = i.load;
  const ratio = l ? (l.acwr ?? (l.atl !== null && l.ctl ? l.atl / l.ctl : null)) : null;
  if (l && ratio !== null && !tooOld(l.date, today)) {
    const status = ratio <= THRESHOLDS.acwr.okUpTo ? "ok" : ratio <= THRESHOLDS.acwr.cautionUpTo ? "caution" : "poor";
    const loads = l.atl !== null && l.ctl !== null ? `Acute load ${num(l.atl)} against chronic ${num(l.ctl)}, ratio ${num(ratio)}` : `Acute to chronic load ratio ${num(ratio)}`;
    signals.push(sig("load", status, `${loads} on ${dm(l.date)}.`));
  } else signals.push(unknown("load", "Recent load", l?.date ?? null, today));

  const known = signals.filter((s) => s.status !== "unknown");
  const poor = known.filter((s) => s.status === "poor").length;
  const points = known.reduce((n, s) => n + (s.status === "poor" ? 2 : s.status === "caution" ? 1 : 0), 0);
  const planned = i.planned;
  const demanding = planned !== null && ((planned.durationS ?? 0) >= THRESHOLDS.demandingMinutes * 60 || DEMANDING_NAME.test(planned.name));

  let state: VerdictState;
  if (known.length < THRESHOLDS.minKnownSignals) state = "unknown";
  else if (poor >= 3 || points >= 7) state = "rest";
  else if (poor >= 2 || points >= 4) state = "swap";
  else if (points >= 2 || poor >= 1) state = "easier";
  else state = "go";
  // A long or hard session on a day that is already borderline moves one step towards recovery.
  if (state === "easier" && demanding && points >= 3) state = "swap";

  const order = { poor: 0, caution: 1, ok: 2, unknown: 3 } as const;
  const reasons = [...signals].sort((a, c) => order[a.status] - order[c.status]).map((s) => s.text);
  if (state === "unknown") reasons.unshift(`Only ${known.length} of ${signals.length} readiness measures are available, so there is no verdict today.`);
  if (planned) reasons.push(`Planned today: ${planned.name}${demanding ? " (a long or hard session)" : ""}.`);
  else reasons.push("Nothing is planned today.");
  if (state === "rest") reasons.push("Several measures are poor together. Rest today.");

  return { state, label: VERDICT_LABELS[state], reasons, signals, points, plannedWorkout: planned?.name ?? null, healthNote: HEALTH_NOTE };
}

/** Words that mean the question is about illness, pain or injury. Those always get the same advice, whatever the data says. */
const HEALTH_WORDS = /\b(ill|illness|sick|unwell|fever|temperature|flu|covid|infection|cough|chest pain|dizzy|faint|injur\w*|pain\w*|hurts?|sore|strain\w*|sprain\w*|swollen|swelling|pulled|torn|tendon|stress fracture|shin splints?|knee pain)\b/i;

export function mentionsHealthConcern(text: string): boolean {
  return HEALTH_WORDS.test(text);
}

export const HEALTH_ADVICE = "Rest today and see a doctor or physio. I cannot assess illness, pain or injury, so the readiness verdict does not apply. This is not medical advice.";
