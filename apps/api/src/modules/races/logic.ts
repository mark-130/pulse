import type { Priority, RaceClass, RaceFlag, RaceType, RaceView, RaceWarning } from "@pulse/shared";
import { addDays, daysBetween } from "../../dates.js";

/** Pure race rules from docs/TRAINING.md. No database, no clock, no race names. */

export interface RaceInput {
  eventKey: string;
  title: string;
  date: string;
  startTimeLocal: string | null;
  timeZone: string | null;
  distanceM: number | null;
  goalTimeSeconds: number | null;
  isRace: boolean;
  primaryEvent: boolean;
  location: string | null;
  url: string | null;
}

export interface MetaInput {
  priority: Priority | null;
  type: RaceType | null;
  goalOverrideS: number | null;
}

export interface WorkoutInput {
  date: string;
  durationS: number | null;
}

export const CLUSTER_DAYS = 21;
export const UNVERIFIED_BEFORE_HOUR = 5;
export const LONG_RUN_MIN_S = 90 * 60;
export const LONG_RUN_LOOKAHEAD_DAYS = 7;
/** Words in a title that make an event a trail race when Mark has not set the type. */
export const TRAIL_KEYWORDS = ["trail", "snowdonia"];
const HALF_M = 21_097.5;
const MARATHON_M = 42_195;

/** Distance classes by metres. A half marathon is 15 km up to 35 km. */
export function classify(distanceM: number | null): RaceClass | null {
  if (distanceM === null) return null;
  if (distanceM >= 35_000) return "marathon";
  if (distanceM >= 15_000) return "half";
  return "10k";
}

/** Distance from the title, only used when Garmin has none. */
export function inferDistanceM(title: string): number | null {
  const t = title.toLowerCase();
  if (/half[\s-]*marathon|\bhalf\b/.test(t)) return HALF_M;
  if (/marathon/.test(t)) return MARATHON_M;
  if (/\b10\s?k\b|10\s?km/.test(t)) return 10_000;
  return null;
}

export function inferType(title: string): RaceType {
  const t = title.toLowerCase();
  return TRAIL_KEYWORDS.some((k) => t.includes(k)) ? "trail" : "road";
}

export function inferPriority(r: Pick<RaceInput, "isRace" | "primaryEvent">): Priority {
  if (r.primaryEvent) return "A";
  if (!r.isRace) return "C";
  return "B";
}

/** Taper length in days. B for a marathon is not in TRAINING.md, see D30. */
export function taperDays(cls: RaceClass | null, priority: Priority): number {
  if (cls === null || priority === "C") return 0;
  const table: Record<RaceClass, Record<"A" | "B", number>> = {
    "10k": { A: 7, B: 4 },
    half: { A: 10, B: 6 },
    marathon: { A: 21, B: 10 },
  };
  return table[cls][priority];
}

/** Easy running only after the race. Trail adds days. C races are treated as workouts, so none. */
export function recoveryDays(cls: RaceClass | null, priority: Priority, type: RaceType): number {
  if (cls === null || priority === "C") return 0;
  const base: Record<RaceClass, number> = { "10k": 3, half: 6, marathon: 12 };
  const trail = type === "trail" ? (cls === "10k" ? 1 : 2) : 0;
  return base[cls] + trail;
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function startHour(start: string | null): number | null {
  const m = start?.match(/(?:^|T|\s)(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

function flagsFor(r: RaceInput, goal: number | null, distanceInferred: boolean, distanceM: number | null): RaceFlag[] {
  const flags: RaceFlag[] = [];
  const hour = startHour(r.startTimeLocal);
  if (r.startTimeLocal === null || hour === null) flags.push({ kind: "start_unknown", text: "Start time unknown." });
  else if (hour < UNVERIFIED_BEFORE_HOUR) {
    const t = r.startTimeLocal.match(/(\d{1,2}:\d{2})/)?.[1] ?? r.startTimeLocal;
    flags.push({ kind: "unverified_time", text: `Unverified: the start is ${t}${r.timeZone ? ` (${r.timeZone})` : ""}, before 05:00. Check it with the organiser.` });
  }
  if (goal === null) flags.push({ kind: "no_goal", text: "No goal time. Add one in Garmin Connect." });
  if (!r.isRace) flags.push({ kind: "not_a_race", text: "Garmin does not mark this as a race. It counts as C unless you set a priority." });
  if (distanceInferred) flags.push({ kind: "distance_inferred", text: "Distance guessed from the title. Add it in Garmin Connect." });
  if (distanceM === null) flags.push({ kind: "distance_unknown", text: "No distance known. Add it in Garmin Connect." });
  return flags;
}

export function buildRace(r: RaceInput, meta: MetaInput | undefined, today: string): RaceView {
  const inferredDistance = r.distanceM === null ? inferDistanceM(r.title) : null;
  const distanceM = r.distanceM ?? inferredDistance;
  const distanceInferred = r.distanceM === null && inferredDistance !== null;
  const cls = classify(distanceM);
  const priority = meta?.priority ?? inferPriority(r);
  const type = meta?.type ?? inferType(r.title);
  const goal = meta?.goalOverrideS ?? r.goalTimeSeconds;
  const days = taperDays(cls, priority);
  const start = days > 0 ? addDays(r.date, -days) : null;
  const recDays = recoveryDays(cls, priority, type);
  const until = recDays > 0 ? addDays(r.date, recDays) : null;
  return {
    eventKey: r.eventKey,
    title: r.title,
    date: r.date,
    startTimeLocal: r.startTimeLocal,
    timeZone: r.timeZone,
    distanceM,
    distanceInferred,
    goalTimeSeconds: goal,
    isRace: r.isRace,
    primaryEvent: r.primaryEvent,
    location: r.location,
    url: r.url,
    daysUntil: daysBetween(today, r.date),
    past: r.date < today,
    priority,
    type,
    priorityInferred: meta?.priority == null,
    typeInferred: meta?.type == null,
    classified: meta?.priority != null && meta?.type != null,
    raceClass: cls,
    taper: { days, start },
    recovery: { days: recDays, until },
    flags: flagsFor(r, goal, distanceInferred, distanceM),
  };
}

function isHalfOrLonger(r: RaceView): boolean {
  return r.raceClass === "half" || r.raceClass === "marathon";
}

export function buildWarnings(races: RaceView[], workouts: WorkoutInput[], today: string): RaceWarning[] {
  const out: RaceWarning[] = [];
  const upcoming = races.filter((r) => !r.past).sort((a, b) => a.date.localeCompare(b.date));

  // Clusters: connected races within 21 days where either end of a link is a half marathon or longer.
  const parent = new Map(upcoming.map((r) => [r.eventKey, r.eventKey]));
  const find = (k: string): string => {
    let x = k;
    while (parent.get(x) !== x) x = parent.get(x) as string;
    return x;
  };
  for (let i = 0; i < upcoming.length; i++) {
    for (let j = i + 1; j < upcoming.length; j++) {
      const a = upcoming[i] as RaceView;
      const b = upcoming[j] as RaceView;
      if (daysBetween(a.date, b.date) <= CLUSTER_DAYS && (isHalfOrLonger(a) || isHalfOrLonger(b))) parent.set(find(a.eventKey), find(b.eventKey));
    }
  }
  const groups = new Map<string, RaceView[]>();
  for (const r of upcoming) groups.set(find(r.eventKey), [...(groups.get(find(r.eventKey)) ?? []), r]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const aCount = g.filter((r) => r.priority === "A").length;
    // Settled only when exactly one race is A and Mark has set that priority.
    const explicitA = g.filter((r) => r.priority === "A" && !r.priorityInferred).length;
    const needsChoice = aCount > 1 || explicitA !== 1;
    const first = g[0] as RaceView;
    const last = g[g.length - 1] as RaceView;
    const span = daysBetween(first.date, last.date);
    const names = g.map((r) => r.title).join(", ");
    const message = needsChoice
      ? `${g.length} races within ${plural(Math.max(span, 1), "day")} of each other: ${names}. Their priorities are not settled: more than one is A, or the A race was not set by you.`
      : `${g.length} races within ${plural(Math.max(span, 1), "day")} of each other: ${names}.`;
    out.push({ id: `cluster:${g.map((r) => r.eventKey).join("+")}`, kind: "cluster", severity: needsChoice ? "action" : "info", raceKeys: g.map((r) => r.eventKey), message, needsChoice });
  }

  // Recovery and taper clashes between an earlier and a later race.
  for (const later of upcoming) {
    for (const earlier of races) {
      if (earlier.eventKey === later.eventKey || earlier.date >= later.date) continue;
      if (earlier.recovery.until && later.date <= earlier.recovery.until) {
        out.push({
          id: `recovery:${earlier.eventKey}>${later.eventKey}`,
          kind: "recovery_clash",
          severity: "action",
          raceKeys: [earlier.eventKey, later.eventKey],
          message: `${later.title} is ${plural(daysBetween(earlier.date, later.date), "day")} after ${earlier.title}, inside its reference recovery window, which runs to ${dm(earlier.recovery.until)}.`,
          needsChoice: false,
        });
      }
      if (!earlier.past && later.taper.start && earlier.date >= later.taper.start) {
        out.push({
          id: `taper:${earlier.eventKey}>${later.eventKey}`,
          kind: "taper_clash",
          severity: "action",
          raceKeys: [earlier.eventKey, later.eventKey],
          message: `${earlier.title} on ${dm(earlier.date)} falls inside the reference taper window before ${later.title}, which starts ${dm(later.taper.start)}.`,
          needsChoice: false,
        });
      }
    }
  }

  // A long scheduled run in the week before a race that is not a C race.
  for (const r of upcoming) {
    if (r.priority === "C") continue;
    for (const w of workouts) {
      const before = daysBetween(w.date, r.date);
      if (before < 1 || before > LONG_RUN_LOOKAHEAD_DAYS || w.date < today || (w.durationS ?? 0) < LONG_RUN_MIN_S) continue;
      out.push({
        id: `long_run:${r.eventKey}@${w.date}`,
        kind: "long_run",
        severity: "info",
        raceKeys: [r.eventKey],
        message: `A ${Math.round((w.durationS ?? 0) / 60)} minute session is scheduled on ${dm(w.date)}, ${plural(before, "day")} before ${r.title}.`,
        needsChoice: false,
      });
    }
  }
  return out;
}

export function buildRaces(rows: RaceInput[], metas: Map<string, MetaInput>, workouts: WorkoutInput[], today: string): { races: RaceView[]; warnings: RaceWarning[] } {
  const races = rows.map((r) => buildRace(r, metas.get(r.eventKey), today)).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { races, warnings: buildWarnings(races, workouts, today) };
}
