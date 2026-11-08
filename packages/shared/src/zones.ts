import { z } from "zod";

/**
 * Heart rate zones (D46). Kotcha, Mark's coaching app, owns his training zones. NGtive Split holds a manual copy (the TOP of each
 * zone in bpm) and shows Garmin's zones next to it. Neither is advice: facts only (D42).
 */
export const KOTCHA_NAMES = ["Recovery", "Aerobic Endurance", "Aerobic Power", "Threshold", "Anaerobic"] as const;
/** Starting values, read as the top of each zone in bpm. Zone 5 is the max heart rate. */
export const KOTCHA_SEED_TOPS = [128, 143, 150, 157, 180] as const;
export const ZONE_COUNT = 5;

export const garminZonesSchema = z.object({
  /** RUNNING when Garmin has a running profile, otherwise DEFAULT. */
  profile: z.enum(["RUNNING", "DEFAULT"]),
  usingDefault: z.boolean(),
  method: z.string(),
  resting: z.number().nullable(),
  lactateThreshold: z.number().nullable(),
  max: z.number(),
  /** Zone 1 to 5 floors. */
  floors: z.array(z.number()).length(ZONE_COUNT),
});
export type GarminZones = z.infer<typeof garminZonesSchema>;

export interface ZoneRange {
  zone: number;
  /** Lowest bpm of the zone. Null for Kotcha zone 1, which is "up to" its top. */
  from: number | null;
  top: number;
}

/** Garmin's tops: the next zone's floor minus 1, and the max heart rate for zone 5. */
export function garminRanges(z: Pick<GarminZones, "floors" | "max">): ZoneRange[] {
  return z.floors.map((floor, i) => ({ zone: i + 1, from: floor, top: i === ZONE_COUNT - 1 ? z.max : (z.floors[i + 1] as number) - 1 }));
}

/** Kotcha's ranges from the tops: zone 1 up to its top, zone 2 from the previous top plus 1, and so on. */
export function kotchaRanges(tops: readonly number[]): ZoneRange[] {
  return tops.map((top, i) => ({ zone: i + 1, from: i === 0 ? null : (tops[i - 1] as number) + 1, top }));
}

export type TopsCheck = { ok: true; tops: number[] } | { ok: false; errors: string[] };

/** Whole numbers, five of them, strictly ascending, and zone 5 equal to the max heart rate. Used by the API and by the sheet. */
export function validateKotchaTops(input: unknown, max: number | null): TopsCheck {
  const errors: string[] = [];
  if (!Array.isArray(input) || input.length !== ZONE_COUNT) return { ok: false, errors: ["Enter all five zone tops."] };
  const tops = input as unknown[];
  tops.forEach((v, i) => {
    if (typeof v !== "number" || !Number.isInteger(v)) errors.push(`Zone ${i + 1} must be a whole number.`);
    else if (v < 30 || v > 250) errors.push(`Zone ${i + 1} must be between 30 and 250 bpm.`);
  });
  if (errors.length) return { ok: false, errors };
  const n = tops as number[];
  for (let i = 1; i < n.length; i++) if ((n[i] as number) <= (n[i - 1] as number)) errors.push(`Zone ${i + 1} must be higher than zone ${i}.`);
  if (max === null) errors.push("Garmin's max heart rate is not known yet, so zone 5 cannot be checked. Try again after the next sync.");
  else if (n[ZONE_COUNT - 1] !== max) errors.push(`Zone 5 must equal your max heart rate, ${max}.`);
  return errors.length ? { ok: false, errors } : { ok: true, tops: n };
}

export const zoneRangeSchema = z.object({ zone: z.number(), from: z.number().nullable(), top: z.number() });

export const zonesResponseSchema = z.object({
  kotcha: z.object({
    zones: z.array(z.object({ zone: z.number(), name: z.string(), from: z.number().nullable(), top: z.number() })),
    /** seed: starting values never saved by Mark. manual: saved by Mark. */
    source: z.enum(["seed", "manual"]),
    savedAt: z.string().nullable(),
  }),
  garmin: z
    .object({
      zones: garminZonesSchema,
      ranges: z.array(zoneRangeSchema),
      /** Date the app first saw these zones. */
      firstSeen: z.string().nullable(),
      fetchedAt: z.string().nullable(),
      ageMinutes: z.number().nullable(),
      stale: z.boolean(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  /** Zones whose tops differ between Garmin and Kotcha. Information only, never a warning. */
  differences: z.array(z.object({ zone: z.number(), garminTop: z.number(), kotchaTop: z.number(), text: z.string() })),
  /** Open while Garmin's zones differ from the ones Mark last confirmed. */
  warning: z.object({ changedOn: z.string(), changes: z.array(z.string()), text: z.string() }).nullable(),
  /** False until the first save, which is when the current Garmin zones are taken as confirmed. */
  confirmed: z.boolean(),
});
export type ZonesResponse = z.infer<typeof zonesResponseSchema>;

export const kotchaSaveSchema = z.object({ tops: z.array(z.number()) });

export const vo2PointSchema = z.object({ date: z.string(), value: z.number(), carriedForward: z.boolean() });
export type Vo2Point = z.infer<typeof vo2PointSchema>;

export const vo2ResponseSchema = z.object({
  points: z.array(vo2PointSchema),
  current: vo2PointSchema.nullable(),
  /** From the first and last value in the 30 days up to the latest point. Null with fewer than two values. */
  change30: z.object({ direction: z.enum(["up", "down", "none"]), delta: z.number(), text: z.string() }).nullable(),
  /** First and last date held, so a chart can say what is not imported yet. */
  stored: z.object({ from: z.string(), to: z.string() }).nullable(),
  fetchedAt: z.string().nullable(),
  ageMinutes: z.number().nullable(),
  stale: z.boolean(),
  lastError: z.string().nullable(),
});
export type Vo2Response = z.infer<typeof vo2ResponseSchema>;

/** "Up 0.4 over 30 days", "Down 0.6 over 30 days" or "No change over 30 days", from the first and last values. */
export function vo2Change(points: readonly Vo2Point[]): Vo2Response["change30"] {
  if (points.length < 2) return null;
  const last = points[points.length - 1] as Vo2Point;
  const limit = new Date(Date.parse(`${last.date}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const window = points.filter((p) => p.date >= limit);
  if (window.length < 2) return null;
  const delta = Math.round(((window[window.length - 1] as Vo2Point).value - (window[0] as Vo2Point).value) * 10) / 10;
  if (delta === 0) return { direction: "none", delta: 0, text: "No change over 30 days" };
  return { direction: delta > 0 ? "up" : "down", delta, text: `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta).toFixed(1)} over 30 days` };
}
