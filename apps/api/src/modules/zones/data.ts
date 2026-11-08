import { asc, desc, eq } from "drizzle-orm";
import {
  KOTCHA_NAMES,
  KOTCHA_SEED_TOPS,
  garminRanges,
  garminZonesSchema,
  kotchaRanges,
  validateKotchaTops,
  vo2Change,
  type GarminZones,
  type Vo2Point,
  type Vo2Response,
  type ZonesResponse,
} from "@pulse/shared";
import { addDays, londonDate } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { garminSnapshot, hrZonesHistory, kotchaZone, settings, syncState, vo2maxPoint } from "../../db/schema.js";
import { kindJob } from "../garmin/freshness.js";
import { appendAudit } from "../proposals/audit.js";
import { diffZones, sameZones, topDifferences, warningText } from "./logic.js";

const CONFIRMED_KEY = "kotcha_confirmed_garmin";
const STALE_AFTER_MIN = 90;

/** Seeds Mark's Kotcha copy the first time it is read. Starting values only: they count as saved once he edits them. */
export function ensureKotcha(db: Db, now: Date): void {
  if (db.select().from(kotchaZone).all().length > 0) return;
  KOTCHA_SEED_TOPS.forEach((top, i) => db.insert(kotchaZone).values({ zone: i + 1, name: KOTCHA_NAMES[i] as string, topBpm: top, source: "seed", updatedAt: now.toISOString() }).run());
}

/** Records a set of Garmin zones when it differs from the last one seen, so the date of a change is known. */
export function recordZonesHistory(db: Db, z: GarminZones, today: string): void {
  const last = db.select().from(hrZonesHistory).orderBy(desc(hrZonesHistory.id)).limit(1).get();
  if (last && sameZones({ profile: last.profile, usingDefault: last.profile === "DEFAULT", method: last.method, resting: last.restingHr, lactateThreshold: last.lactateThresholdHr, max: last.maxHr, floors: last.floors }, z)) return;
  db.insert(hrZonesHistory).values({ firstSeen: today, profile: z.profile, method: z.method, floors: z.floors, maxHr: z.max, restingHr: z.resting, lactateThresholdHr: z.lactateThreshold }).run();
}

export function kindStatus(db: Db, task: string, now: Date) {
  const s = db.select().from(syncState).where(eq(syncState.job, kindJob(task))).get();
  const ageMinutes = s?.lastOk ? Math.max(0, Math.round((now.getTime() - Date.parse(s.lastOk)) / 60_000)) : null;
  return { fetchedAt: s?.lastOk ?? null, ageMinutes, stale: ageMinutes === null || ageMinutes > STALE_AFTER_MIN, lastError: s?.lastError ?? null };
}

/** The latest successfully stored Garmin zones. A failed or stale fetch leaves this as it was. */
export function latestGarminZones(db: Db): { zones: GarminZones; date: string } | null {
  const row = db.select().from(garminSnapshot).where(eq(garminSnapshot.kind, "hr_zones")).orderBy(desc(garminSnapshot.date)).limit(1).get();
  if (!row) return null;
  const p = garminZonesSchema.safeParse(row.payload);
  return p.success ? { zones: p.data, date: row.date } : null;
}

function confirmedZones(db: Db): GarminZones | null {
  const row = db.select().from(settings).where(eq(settings.key, CONFIRMED_KEY)).get();
  const p = garminZonesSchema.safeParse((row?.value as { zones?: unknown } | undefined)?.zones);
  return p.success ? p.data : null;
}

function kotchaRows(db: Db) {
  return db.select().from(kotchaZone).orderBy(asc(kotchaZone.zone)).all();
}

export function getZonesView(db: Db, now: Date): ZonesResponse {
  ensureKotcha(db, now);
  const rows = kotchaRows(db);
  const tops = rows.map((r) => r.topBpm);
  const ranges = kotchaRanges(tops);
  const latest = latestGarminZones(db);
  const confirmed = confirmedZones(db);
  const history = db.select().from(hrZonesHistory).orderBy(desc(hrZonesHistory.id)).all();
  const firstSeen = latest ? (history.find((h) => sameZones({ profile: h.profile, usingDefault: false, method: h.method, resting: null, lactateThreshold: null, max: h.maxHr, floors: h.floors }, latest.zones))?.firstSeen ?? latest.date) : null;

  let warning: ZonesResponse["warning"] = null;
  if (latest && confirmed && !sameZones(confirmed, latest.zones)) {
    const changes = diffZones(confirmed, latest.zones);
    const changedOn = firstSeen ?? latest.date;
    warning = { changedOn, changes, text: warningText(changedOn, changes) };
  }
  const status = kindStatus(db, "hr_zones", now);
  return {
    kotcha: {
      zones: rows.map((r, i) => ({ zone: r.zone, name: r.name, from: ranges[i]?.from ?? null, top: r.topBpm })),
      source: rows.every((r) => r.source === "manual") ? "manual" : "seed",
      savedAt: rows.every((r) => r.source === "manual") ? (rows.map((r) => r.updatedAt).sort().at(-1) ?? null) : null,
    },
    garmin: latest ? { zones: latest.zones, ranges: garminRanges(latest.zones), firstSeen, ...status } : null,
    differences: latest ? topDifferences(latest.zones, tops) : [],
    warning,
    confirmed: confirmed !== null,
  };
}

export class ZonesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

function setConfirmed(db: Db, zones: GarminZones, nowIso: string): void {
  const value = { zones, confirmedAt: nowIso };
  db.insert(settings).values({ key: CONFIRMED_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** An explicit save of Mark's Kotcha copy. Audited with the old and new tops. The first save also takes the current Garmin zones as confirmed. */
export function saveKotcha(db: Db, input: unknown, now: Date): ZonesResponse {
  ensureKotcha(db, now);
  const latest = latestGarminZones(db);
  const check = validateKotchaTops(input, latest?.zones.max ?? null);
  if (!check.ok) throw new ZonesError(check.errors.join(" "), 400);
  const nowIso = now.toISOString();
  const old = kotchaRows(db).map((r) => r.topBpm);
  db.transaction(() => {
    check.tops.forEach((top, i) => db.update(kotchaZone).set({ topBpm: top, source: "manual", updatedAt: nowIso }).where(eq(kotchaZone.zone, i + 1)).run());
    if (confirmedZones(db) === null && latest) setConfirmed(db, latest.zones, nowIso);
    appendAudit(db, { ts: nowIso, actor: "user", action: "settings.kotcha_zones", target: "settings.kotcha_zones", payload: { old, new: check.tops }, result: JSON.stringify({ old, new: check.tops, confirmedGarmin: confirmedZones(db) !== null }) });
  });
  return getZonesView(db, now);
}

/** "Kotcha is up to date": the current Garmin zones become the confirmed ones and the warning clears until Garmin changes again. */
export function confirmGarmin(db: Db, now: Date): ZonesResponse {
  const latest = latestGarminZones(db);
  if (!latest) throw new ZonesError("There are no Garmin zones to confirm yet.", 409);
  const nowIso = now.toISOString();
  const before = confirmedZones(db);
  db.transaction(() => {
    setConfirmed(db, latest.zones, nowIso);
    appendAudit(db, { ts: nowIso, actor: "user", action: "settings.kotcha_garmin_confirmed", target: "settings.kotcha_zones", payload: { confirmed: latest.zones }, result: JSON.stringify({ from: before, to: latest.zones }) });
  });
  return getZonesView(db, now);
}

/** Daily VO2 max points for the last `days` days, with the 30 day change worked out in code. */
export function getVo2View(db: Db, now: Date, days = 30): Vo2Response {
  const today = londonDate(now);
  const all = db.select().from(vo2maxPoint).orderBy(asc(vo2maxPoint.date)).all();
  const points: Vo2Point[] = all.filter((p) => p.date >= addDays(today, -days)).map((p) => ({ date: p.date, value: p.value, carriedForward: p.carriedForward }));
  const current = points.at(-1) ?? null;
  return { points, current, change30: vo2Change(points), stored: all.length ? { from: (all[0] as { date: string }).date, to: (all.at(-1) as { date: string }).date } : null, ...kindStatus(db, "vo2max", now) };
}

