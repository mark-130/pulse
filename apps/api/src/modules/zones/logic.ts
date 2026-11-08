import { ZONE_COUNT, garminRanges, kotchaRanges, type GarminZones, type ZonesResponse } from "@pulse/shared";
import { hrZonesSchema } from "../garmin/upstream.js";

/** Pure zone rules (D46). No database, no clock. Facts only: nothing here says how to train in a zone. */

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** The running profile if Garmin has one, otherwise the DEFAULT profile. Null when the payload holds neither. */
export function chooseProfile(payload: unknown): GarminZones | null {
  const parsed = hrZonesSchema.safeParse(payload);
  if (!parsed.success) return null;
  const running = parsed.data.find((p) => p.sport.toUpperCase() === "RUNNING");
  const chosen = running ?? parsed.data.find((p) => p.sport.toUpperCase() === "DEFAULT");
  if (!chosen) return null;
  return {
    profile: running ? "RUNNING" : "DEFAULT",
    usingDefault: !running,
    method: chosen.trainingMethod ?? "UNKNOWN",
    resting: chosen.restingHeartRateUsed ?? null,
    lactateThreshold: chosen.lactateThresholdHeartRateUsed ?? null,
    max: chosen.maxHeartRateUsed,
    floors: [chosen.zone1Floor, chosen.zone2Floor, chosen.zone3Floor, chosen.zone4Floor, chosen.zone5Floor],
  };
}

/** Garmin's zones are the same when the profile, method, floors and max heart rate are. Resting and lactate threshold alone do not count. */
export function sameZones(a: GarminZones, b: GarminZones): boolean {
  return a.profile === b.profile && a.method === b.method && a.max === b.max && a.floors.every((f, i) => f === b.floors[i]);
}

/** What changed, in short plain phrases such as "Zone 2 floor 130 to 132". */
export function diffZones(from: GarminZones, to: GarminZones): string[] {
  const out: string[] = [];
  if (from.profile !== to.profile) out.push(`Profile ${from.profile.toLowerCase()} to ${to.profile.toLowerCase()}`);
  if (from.method !== to.method) out.push(`Method ${from.method} to ${to.method}`);
  for (let i = 0; i < ZONE_COUNT; i++) if (from.floors[i] !== to.floors[i]) out.push(`Zone ${i + 1} floor ${from.floors[i]} to ${to.floors[i]}`);
  if (from.max !== to.max) out.push(`Max heart rate ${from.max} to ${to.max}`);
  return out;
}

export function warningText(changedOn: string, changes: string[]): string {
  return `Garmin changed your heart rate zones on ${dm(changedOn)}. ${changes.join(". ")}. Update Kotcha, then confirm here.`;
}

/** Zones whose tops differ. Information, never a warning: a 1 bpm gap in zone 1 is normal rounding between the two. */
export function topDifferences(garmin: GarminZones, kotchaTops: readonly number[]): ZonesResponse["differences"] {
  return garminRanges(garmin).flatMap((r) => {
    const k = kotchaTops[r.zone - 1];
    return k !== undefined && k !== r.top ? [{ zone: r.zone, garminTop: r.top, kotchaTop: k, text: `Zone ${r.zone} top: Garmin ${r.top}, Kotcha ${k}` }] : [];
  });
}

export { garminRanges, kotchaRanges };
