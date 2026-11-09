import { eq, notInArray } from "drizzle-orm";
import { FORECAST_REFRESH_HOURS, FORECAST_STALE_HOURS, WEATHER_WINDOW_DAYS, type ForecastPlace, type PlaceSource, type RaceView, type RaceWeather } from "@pulse/shared";
import { addDays } from "../../dates.js";
import type { Db } from "../../db/index.js";
import { race as raceTable, raceForecast, raceMeta, racePlace, syncState } from "../../db/schema.js";
import type { Logger } from "../../logger.js";
import { appendAudit } from "../proposals/audit.js";
import { getRaceView } from "../races/data.js";
import { fetchForecast, geocodeOne, geocodePlace, WeatherError, type FetchFn, type Place } from "./openmeteo.js";
import { convertLocal, parseCoordinates, selectHours, titleCandidates, todayLine, type RawHour } from "./logic.js";

const HOUR_MS = 3_600_000;
/** After a failed lookup or fetch, wait this long before trying again. The job runs every 30 minutes, so this is the next run. */
export const RETRY_AFTER_FAILURE_MS = 25 * 60_000;
/** A place that was not found is looked up again after this long, in case a Garmin location or a title was fixed. */
export const NOT_FOUND_RETRY_MS = 24 * HOUR_MS;
const MAX_LOOKUPS_PER_RUN = 12;
const JOB = "weather";

type MetaRow = typeof raceMeta.$inferSelect;
const startOf = (start: string | null): string | null => start?.match(/(\d{1,2}:\d{2})/)?.[1] ?? null;

interface Wanted {
  source: PlaceSource;
  query: string;
  /** Known without a lookup: the manual place, or Garmin's location written as coordinates. */
  direct: Place | null;
}

/** Where to look, in order: Mark's manual place, Garmin's location on the event, then the town or venue in the title. */
export function wantedPlace(race: Pick<RaceView, "location" | "title">, meta: MetaRow | undefined): Wanted | null {
  if (meta?.forecastLat != null && meta.forecastLon != null && meta.forecastPlace) {
    return { source: "manual", query: meta.forecastPlace, direct: { name: meta.forecastName ?? meta.forecastPlace, latitude: meta.forecastLat, longitude: meta.forecastLon } };
  }
  const loc = race.location?.trim();
  if (loc) {
    const c = parseCoordinates(loc);
    return { source: "garmin", query: loc, direct: c ? { name: `${c.latitude}, ${c.longitude}`, ...c } : null };
  }
  return { source: "title", query: race.title, direct: null };
}

function cachedPlace(db: Db, key: string, w: Wanted): typeof racePlace.$inferSelect | undefined {
  const row = db.select().from(racePlace).where(eq(racePlace.raceKey, key)).get();
  return row && row.source === w.source && row.query === w.query ? row : undefined;
}

/** The place for a race from what is stored. No network. */
export function placeState(db: Db, race: Pick<RaceView, "eventKey" | "location" | "title">, meta: MetaRow | undefined): ForecastPlace {
  const w = wantedPlace(race, meta);
  if (!w) return { state: "not_found" };
  if (w.direct) return { state: "found", name: w.direct.name, latitude: w.direct.latitude, longitude: w.direct.longitude, source: w.source };
  const row = cachedPlace(db, race.eventKey, w);
  if (!row) return { state: "pending", reason: null };
  if (row.status === "found" && row.latitude !== null && row.longitude !== null) return { state: "found", name: row.name ?? w.query, latitude: row.latitude, longitude: row.longitude, source: w.source };
  if (row.status === "not_found") return { state: "not_found" };
  return { state: "pending", reason: row.lastError };
}

async function lookup(fetchFn: FetchFn, w: Wanted): Promise<Place | null> {
  if (w.source === "title") {
    for (const c of titleCandidates(w.query)) {
      const hit = await geocodeOne(fetchFn, c);
      if (hit) return hit;
    }
    return null;
  }
  return geocodePlace(fetchFn, w.query);
}

const reasonOf = (err: unknown): string => (err instanceof WeatherError ? err.message : "The forecast lookup failed.");

/** Resolves and caches the place for one race when it is missing or due. Returns true if it made a request. */
async function ensurePlace(db: Db, fetchFn: FetchFn, race: RaceView, meta: MetaRow | undefined, now: Date): Promise<boolean> {
  const w = wantedPlace(race, meta);
  if (!w || w.direct) return false;
  const row = cachedPlace(db, race.eventKey, w);
  if (row) {
    const age = now.getTime() - Date.parse(row.lastAttempt);
    if (row.status === "found") return false;
    if (row.status === "not_found" && age < NOT_FOUND_RETRY_MS) return false;
    if (row.status === "error" && age < RETRY_AFTER_FAILURE_MS) return false;
  }
  const nowIso = now.toISOString();
  try {
    const hit = await lookup(fetchFn, w);
    const values = { source: w.source, query: w.query, status: hit ? "found" : "not_found", name: hit?.name ?? null, latitude: hit?.latitude ?? null, longitude: hit?.longitude ?? null, lastAttempt: nowIso, lastError: null };
    const before = db.select().from(racePlace).where(eq(racePlace.raceKey, race.eventKey)).get();
    db.insert(racePlace).values({ raceKey: race.eventKey, ...values }).onConflictDoUpdate({ target: racePlace.raceKey, set: values }).run();
    // A different place means the old forecast is for somewhere else.
    if (before && (before.latitude !== values.latitude || before.longitude !== values.longitude)) db.delete(raceForecast).where(eq(raceForecast.raceKey, race.eventKey)).run();
  } catch (err) {
    const values = { source: w.source, query: w.query, status: "error", name: null, latitude: null, longitude: null, lastAttempt: nowIso, lastError: reasonOf(err) };
    db.insert(racePlace).values({ raceKey: race.eventKey, ...values }).onConflictDoUpdate({ target: racePlace.raceKey, set: values }).run();
  }
  return true;
}

const hoursOf = (row: { hours: unknown[] | null } | undefined): RawHour[] => (Array.isArray(row?.hours) ? (row.hours as RawHour[]) : []);

export interface SyncResult {
  checked: number;
  fetched: number;
  failed: number;
  lookups: number;
}

/**
 * The forecast sync (D59). Looks up the place for every upcoming race (cached, so this is rare), then fetches the hourly
 * forecast for races inside the 14 day window when the stored one is missing or older than 3 hours. A failure keeps the
 * last forecast and is retried on the next run. The screens read the result and never call Open-Meteo.
 */
export async function syncWeather(db: Db, fetchFn: FetchFn, now: Date, log?: Logger): Promise<SyncResult> {
  const view = getRaceView(db, now);
  const upcoming = view.races.filter((r) => !r.past);
  const metas = new Map(db.select().from(raceMeta).all().map((m) => [m.metaKey, m]));
  const keys = upcoming.map((r) => r.eventKey);
  // Forget races that are over or gone.
  if (keys.length) {
    db.delete(racePlace).where(notInArray(racePlace.raceKey, keys)).run();
    db.delete(raceForecast).where(notInArray(raceForecast.raceKey, keys)).run();
  } else {
    db.delete(racePlace).run();
    db.delete(raceForecast).run();
  }
  const result: SyncResult = { checked: 0, fetched: 0, failed: 0, lookups: 0 };
  const reasons: string[] = [];
  const nowIso = now.toISOString();
  for (const r of upcoming) {
    if (result.lookups < MAX_LOOKUPS_PER_RUN && (await ensurePlace(db, fetchFn, r, metas.get(r.eventKey), now))) result.lookups++;
    if (r.daysUntil < 0 || r.daysUntil > WEATHER_WINDOW_DAYS) continue;
    const place = placeState(db, r, metas.get(r.eventKey));
    if (place.state !== "found") continue;
    const row = db.select().from(raceForecast).where(eq(raceForecast.raceKey, r.eventKey)).get();
    const sameDay = hoursOf(row)[0]?.time.slice(0, 10) === r.date;
    const fresh = row?.fetchedAt && sameDay && now.getTime() - Date.parse(row.fetchedAt) < FORECAST_REFRESH_HOURS * HOUR_MS;
    const backingOff = row?.lastError && now.getTime() - Date.parse(row.lastAttempt) < RETRY_AFTER_FAILURE_MS;
    if (fresh || backingOff) continue;
    result.checked++;
    try {
      const f = await fetchForecast(fetchFn, place.latitude, place.longitude, r.date);
      const values = { fetchedAt: nowIso, lastAttempt: nowIso, lastError: null, consecutiveFailures: 0, timeZone: f.timeZone, hours: f.hours };
      db.insert(raceForecast).values({ raceKey: r.eventKey, ...values }).onConflictDoUpdate({ target: raceForecast.raceKey, set: values }).run();
      result.fetched++;
    } catch (err) {
      // Keep the last forecast. Only the attempt and the reason change.
      const reason = reasonOf(err);
      const failures = (row?.consecutiveFailures ?? 0) + 1;
      db.insert(raceForecast).values({ raceKey: r.eventKey, lastAttempt: nowIso, lastError: reason, consecutiveFailures: failures })
        .onConflictDoUpdate({ target: raceForecast.raceKey, set: { lastAttempt: nowIso, lastError: reason, consecutiveFailures: failures } }).run();
      result.failed++;
      reasons.push(reason);
      log?.warn({ reason }, "forecast fetch failed");
    }
  }
  recordWeatherJob(db, nowIso, result, reasons[0] ?? null);
  return result;
}

/** One sync_state row for the whole kind, like the Garmin kinds: partial success counts as success with a note. */
function recordWeatherJob(db: Db, nowIso: string, r: SyncResult, firstReason: string | null): void {
  if (r.checked === 0 && r.lookups === 0) return;
  const prev = db.select().from(syncState).where(eq(syncState.job, JOB)).get();
  const detail = r.failed > 0 ? `${r.failed} of ${r.checked} forecasts failed: ${firstReason}` : null;
  const ok = r.failed === 0 || r.fetched > 0;
  const set = {
    lastAttempt: nowIso,
    ...(ok ? { lastOk: nowIso } : {}),
    lastError: r.failed > 0 ? firstReason : null,
    consecutiveFailures: r.failed === 0 || r.fetched > 0 ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    detail,
  };
  db.insert(syncState).values({ job: JOB, ...set }).onConflictDoUpdate({ target: syncState.job, set }).run();
}

/** The cached weather for one race, ready for the screen. Reads the database only. */
export function buildRaceWeather(db: Db, now: Date, race: RaceView): RaceWeather {
  const meta = db.select().from(raceMeta).where(eq(raceMeta.metaKey, race.eventKey)).get();
  const place = placeState(db, race, meta);
  const row = db.select().from(raceForecast).where(eq(raceForecast.raceKey, race.eventKey)).get();
  const hours = hoursOf(row);
  const inWindow = race.daysUntil >= 0 && race.daysUntil <= WEATHER_WINDOW_DAYS;
  const start = startOf(race.startTimeLocal);
  let forecast: RaceWeather["forecast"] = null;
  if (row?.fetchedAt && hours.length > 0 && !race.past) {
    const local = start ? convertLocal(race.date, start, race.timeZone, row.timeZone) : null;
    const sel = selectHours(hours, local?.date ?? null, local?.time ?? null);
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(row.fetchedAt)) / 60_000));
    forecast = {
      fetchedAt: row.fetchedAt,
      ageMinutes: age,
      stale: age > FORECAST_STALE_HOURS * 60,
      refreshFailed: row.lastError !== null && row.lastAttempt > row.fetchedAt,
      reason: row.lastError,
      atStart: sel.atStart,
      strip: sel.strip,
    };
  }
  return {
    raceKey: race.eventKey,
    title: race.title,
    date: race.date,
    daysUntil: race.daysUntil,
    past: race.past,
    place,
    manualPlace: meta?.forecastPlace ?? null,
    inWindow,
    availableFrom: addDays(race.date, -WEATHER_WINDOW_DAYS),
    startLocal: start,
    startUnverified: race.flags.some((f) => f.kind === "unverified_time"),
    raceTimeZone: race.timeZone,
    forecastTimeZone: row?.timeZone ?? null,
    forecast,
    waiting: inWindow && place.state === "found" && forecast === null,
  };
}

export function getRaceWeather(db: Db, now: Date, raceKey: string): RaceWeather | null {
  const r = getRaceView(db, now).races.find((x) => x.eventKey === raceKey);
  return r ? buildRaceWeather(db, now, r) : null;
}

const londonHhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(new Date(iso));

/** The one line for Today when the next race is within 7 days and a forecast at its start exists. Otherwise null. */
export function forecastLine(db: Db, now: Date, race: RaceView | null): string | null {
  if (!race || race.past || race.daysUntil < 0 || race.daysUntil > 7) return null;
  const w = buildRaceWeather(db, now, race);
  if (!w.forecast?.atStart) return null;
  return todayLine(race.date, w.forecast.atStart, w.forecast.stale ? { fetchedHhmm: londonHhmm(w.forecast.fetchedAt) } : null);
}

export class PlaceNotFound extends Error {}

/**
 * Saves the Forecast place Mark typed: geocodes it, and only if it resolves stores the name and coordinates in race_meta,
 * clears the cached forecast for the race, and writes an audit row. An empty place removes the manual place.
 * Only the place text is sent to Open-Meteo.
 */
export async function saveForecastPlace(db: Db, fetchFn: FetchFn, now: Date, key: string, text: string): Promise<{ changed: boolean }> {
  if (!db.select({ id: raceTable.id }).from(raceTable).where(eq(raceTable.eventKey, key)).get()) throw new PlaceNotFound("Unknown race.");
  const typed = text.trim();
  const prev = db.select().from(raceMeta).where(eq(raceMeta.metaKey, key)).get();
  const old = { place: prev?.forecastPlace ?? null, name: prev?.forecastName ?? null, latitude: prev?.forecastLat ?? null, longitude: prev?.forecastLon ?? null };
  let next: typeof old = { place: null, name: null, latitude: null, longitude: null };
  if (typed) {
    // Typed as coordinates, or looked up by name.
    const c = parseCoordinates(typed);
    const hit: Place | null = c ? { name: `${c.latitude}, ${c.longitude}`, ...c } : await geocodePlace(fetchFn, typed);
    if (!hit) throw new PlaceNotFound(`Forecast place not found: ${typed.slice(0, 60)}`);
    next = { place: typed, name: hit.name, latitude: hit.latitude, longitude: hit.longitude };
  }
  const values = { forecastPlace: next.place, forecastName: next.name, forecastLat: next.latitude, forecastLon: next.longitude, updatedAt: now.toISOString() };
  const keepsRow = prev && (prev.priority || prev.type || prev.goalOverrideS || prev.notes);
  if (!next.place && !keepsRow) db.delete(raceMeta).where(eq(raceMeta.metaKey, key)).run();
  else db.insert(raceMeta).values({ metaKey: key, ...values }).onConflictDoUpdate({ target: raceMeta.metaKey, set: values }).run();
  db.delete(raceForecast).where(eq(raceForecast.raceKey, key)).run();
  appendAudit(db, { ts: now.toISOString(), actor: "user", action: "race.forecast_place", target: `race:${key}`, payload: { old, new: next }, result: JSON.stringify({ old, new: next }) });
  return { changed: old.place !== next.place || old.latitude !== next.latitude || old.longitude !== next.longitude };
}

