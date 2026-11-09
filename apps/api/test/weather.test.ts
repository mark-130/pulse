import { describe, expect, it } from "vitest";
import { forecastPlaceResponseSchema, raceWeatherSchema, todayResponseSchema } from "@pulse/shared";
import { auditLog, race, raceForecast, raceMeta, syncState } from "../src/db/schema.js";
import { runTool } from "../src/modules/ai/tools.js";
import { compassPoint, convertLocal, parseCoordinates, selectHours, titleCandidates, weatherDescription, type RawHour } from "../src/modules/weather/logic.js";
import { FORECAST_URL, GEOCODING_URL, USER_AGENT } from "../src/modules/weather/openmeteo.js";
import { TODAY } from "./fixtures.js";
import { makeGarminApp, req } from "./helpers.js";

const NOW0 = new Date(`${TODAY}T12:00:00Z`);
const ADVICE_WORDS = /wear|dress|cloth|jacket|layer|gloves|should|recommend|advice|advise|suggest|pace yourself|pacing|prepare|slow down/i;

type Call = { url: URL; headers: Record<string, string> };

/** A mocked Open-Meteo. Geocoding answers from a table by the name sent, the forecast makes 24 hours for the date asked. */
function mockMeteo(places: Record<string, { name: string; latitude: number; longitude: number; country?: string; admin1?: string }>, tz = "Europe/London") {
  const calls: Call[] = [];
  const state = { failForecast: false, failGeocode: false, dir: 270, zone: tz };
  const fn = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    if (url.origin + url.pathname === GEOCODING_URL) {
      if (state.failGeocode) throw new TypeError("fetch failed");
      const hit = places[url.searchParams.get("name") ?? ""];
      return Response.json(hit ? { results: [hit] } : { generationtime_ms: 0.5 });
    }
    if (url.origin + url.pathname === FORECAST_URL) {
      if (state.failForecast) return new Response("boom", { status: 500 });
      const date = url.searchParams.get("start_date") as string;
      const times = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, "0")}:00`);
      const col = (f: (h: number) => number | null) => times.map((_, h) => f(h));
      return Response.json({
        timezone: state.zone,
        hourly: {
          time: times,
          temperature_2m: col((h) => h),
          apparent_temperature: col((h) => h - 3),
          precipitation_probability: col(() => 40),
          precipitation: col(() => 0.2),
          wind_speed_10m: col(() => 14.4),
          wind_gusts_10m: col(() => 25.6),
          wind_direction_10m: col(() => state.dir),
          weather_code: col(() => 61),
          relative_humidity_2m: col(() => 80),
        },
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const forecastCalls = () => calls.filter((c) => c.url.origin + c.url.pathname === FORECAST_URL);
  const geocodeNames = () => calls.filter((c) => c.url.origin + c.url.pathname === GEOCODING_URL).map((c) => c.url.searchParams.get("name"));
  return { fn, calls, state, forecastCalls, geocodeNames };
}

const WEST_BRIDGFORD = { name: "West Bridgford", latitude: 52.9266, longitude: -1.1275, admin1: "England", country: "United Kingdom" };
const places = { "West Bridgford": WEST_BRIDGFORD, Nottingham: { name: "Nottingham", latitude: 52.9536, longitude: -1.1505, admin1: "England", country: "United Kingdom" }, "Brighton and Hove": { name: "Brighton and Hove", latitude: 50.8429, longitude: -0.1313, admin1: "England", country: "United Kingdom" }, Antwerp: { name: "Antwerp", latitude: 51.2213, longitude: 4.4051, admin1: "Flanders", country: "Belgium" }, Sydney: { name: "Sydney", latitude: -33.8678, longitude: 151.2073, admin1: "New South Wales", country: "Australia" } };

async function setup(opts: { places?: Parameters<typeof mockMeteo>[0]; at?: Date; tz?: string } = {}) {
  const meteo = mockMeteo(opts.places ?? places, opts.tz);
  const clock = { now: opts.at ?? NOW0 };
  const t = await makeGarminApp({ clock: () => clock.now, weatherFetch: meteo.fn });
  await t.post("/api/sync/garmin");
  const keyOf = (title: string) => {
    const r = t.handle.db.select().from(race).all().find((x) => x.title.includes(title));
    if (!r) throw new Error(`no race ${title}`);
    return r.eventKey;
  };
  const addRace = (o: Partial<typeof race.$inferInsert> & { title: string; date: string }) => {
    const eventKey = `${o.date}|${o.title}`;
    t.handle.db.insert(race).values({ eventKey, startTimeLocal: "09:00", timeZone: "Europe/London", distanceM: 10_000, goalTimeSeconds: 3000, isRace: true, primaryEvent: false, subscribed: false, location: null, url: null, active: true, firstSeen: NOW0.toISOString(), lastSeen: NOW0.toISOString(), ...o }).run();
    return eventKey;
  };
  const weatherOf = async (key: string) => raceWeatherSchema.parse(await (await t.get(`/api/races/weather?race=${encodeURIComponent(key)}`)).json());
  const put = (key: string, place: string) => req(t.app, "/api/races/forecast-place", { method: "PUT", headers: { cookie: t.cookie, "x-csrf-token": t.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ key, place }) });
  return { t, meteo, clock, keyOf, addRace, weatherOf, put };
}

describe("compass, units and descriptions", () => {
  it("turns degrees into a 16 point compass name in code", () => {
    expect([0, 11, 12, 90, 180, 225, 270, 292.5, 337.5, 348.75, 360, -90].map(compassPoint)).toEqual(["N", "N", "NNE", "E", "S", "SW", "W", "WNW", "NNW", "N", "N", "W"]);
  });
  it("describes the weather code in plain words", () => {
    expect([0, 3, 45, 61, 80, 95].map(weatherDescription)).toEqual(["Clear sky", "Overcast", "Fog", "Light rain", "Light rain showers", "Thunderstorm"]);
    expect(weatherDescription(null)).toBeNull();
    expect(weatherDescription(1234)).toBe("Unknown conditions");
  });
  it("converts a start time between zones, across a date change", () => {
    expect(convertLocal("2026-11-20", "06:30", "Australia/Sydney", "Europe/London")).toEqual({ date: "2026-11-19", time: "19:30" });
    expect(convertLocal("2026-11-12", "14:00", "Europe/Paris", "Europe/Brussels")).toEqual({ date: "2026-11-12", time: "14:00" });
    expect(convertLocal("2026-11-12", "9:05", null, "Europe/London")).toEqual({ date: "2026-11-12", time: "09:05" });
    expect(convertLocal("2026-11-12", "nope", "Europe/Paris", "Europe/London")).toBeNull();
    expect(convertLocal("2026-11-12", "09:00", "Not/AZone", "Europe/London")).toBeNull();
  });
  it("reads coordinates and builds place guesses from a title", () => {
    expect(parseCoordinates("52.9, -1.1")).toEqual({ latitude: 52.9, longitude: -1.1 });
    expect(parseCoordinates("Brighton and Hove, GB")).toBeNull();
    expect(parseCoordinates("95,10")).toBeNull();
    expect(titleCandidates("Rhino Run West Bridgford")).toEqual(["Rhino West Bridgford", "West Bridgford", "Bridgford"]);
    expect(titleCandidates("Snowdonia Trail Marathon (Half Marathon)")).toEqual(["Snowdonia"]);
    expect(titleCandidates("10K")).toEqual([]);
  });
});

describe("hourly selection around the start", () => {
  const day = "2026-11-14";
  const hours: RawHour[] = Array.from({ length: 24 }, (_, h) => ({ time: `${day}T${String(h).padStart(2, "0")}:00`, temperatureC: h, feelsLikeC: h - 2, rainChancePct: 10, rainMm: 0, windMph: 10, gustMph: 20, windDirDeg: 90, humidityPct: 70, weatherCode: 0 }));
  const times = (s: ReturnType<typeof selectHours>) => s.strip.map((x) => x.time);
  it("is 2 hours before to 3 hours after the start hour, with the start flagged", () => {
    const s = selectHours(hours, day, "09:00");
    expect(times(s)).toEqual(["07:00", "08:00", "09:00", "10:00", "11:00", "12:00"]);
    expect(s.atStart).toMatchObject({ time: "09:00", temperatureC: 9, isStart: true });
    expect(s.strip.filter((x) => x.isStart)).toHaveLength(1);
  });
  it("uses the hour the start falls in, so 09:45 is the 09:00 hour", () => {
    expect(selectHours(hours, day, "09:45").atStart?.time).toBe("09:00");
  });
  it("stops at the edges of the day", () => {
    expect(times(selectHours(hours, day, "01:30"))).toEqual(["00:00", "01:00", "02:00", "03:00", "04:00"]);
    expect(times(selectHours(hours, day, "22:00"))).toEqual(["20:00", "21:00", "22:00", "23:00"]);
  });
  it("with no start time shows the morning and gives no start figures", () => {
    const s = selectHours(hours, null, null);
    expect(s.atStart).toBeNull();
    expect(times(s)).toEqual(["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00"]);
  });
});

describe("where the forecast is taken from", () => {
  it("guesses the town from the title when Garmin has no location, and shows the resolved name and coordinates", async () => {
    const s = await setup();
    await s.t.weather.tick();
    expect(s.meteo.geocodeNames().slice(0, 2)).toEqual(["Rhino West Bridgford", "West Bridgford"]);
    const w = await s.weatherOf(s.keyOf("Rhino"));
    expect(w.place).toEqual({ state: "found", name: "West Bridgford, England, United Kingdom", latitude: 52.9266, longitude: -1.1275, source: "title" });
  });

  it("prefers Garmin's location, then falls back to the part before the comma", async () => {
    const s = await setup();
    const k = s.addRace({ title: "Seafront 10K", date: "2026-11-15", location: "Brighton and Hove, GB" });
    await s.t.weather.tick();
    const names = s.meteo.geocodeNames();
    expect(names).toContain("Brighton and Hove, GB");
    expect(names).toContain("Brighton and Hove");
    // The title is never used when Garmin gives a location.
    expect(names.filter((n) => n?.includes("Seafront"))).toEqual([]);
    expect((await s.weatherOf(k)).place).toMatchObject({ state: "found", source: "garmin", latitude: 50.8429 });
  });

  it("uses coordinates in Garmin's location directly, with no lookup", async () => {
    const s = await setup();
    const k = s.addRace({ title: "Coordinates Run", date: "2026-11-15", location: "52.95, -1.15" });
    await s.t.weather.tick();
    expect(s.meteo.geocodeNames()).not.toContain("52.95, -1.15");
    expect((await s.weatherOf(k)).place).toMatchObject({ state: "found", source: "garmin", latitude: 52.95, longitude: -1.15 });
  });

  it("a manual place beats Garmin's location and the title, is geocoded once on Save, and is audited", async () => {
    const s = await setup();
    const k = s.addRace({ title: "Seafront 10K", date: "2026-11-15", location: "Brighton and Hove, GB" });
    const res = await s.put(k, "Nottingham");
    expect(res.status).toBe(200);
    const body = forecastPlaceResponseSchema.parse(await res.json());
    expect(body.weather.place).toMatchObject({ state: "found", name: "Nottingham, England, United Kingdom", source: "manual", latitude: 52.9536 });
    expect(body.weather.manualPlace).toBe("Nottingham");
    const meta = s.t.handle.db.select().from(raceMeta).all().find((m) => m.metaKey === k);
    expect(meta).toMatchObject({ forecastPlace: "Nottingham", forecastLat: 52.9536, forecastLon: -1.1505 });
    // The sync that follows uses the saved coordinates and never looks Brighton up for this race.
    expect(s.meteo.geocodeNames().filter((n) => n?.startsWith("Brighton and Hove"))).toEqual([]);
    const fc = s.meteo.forecastCalls().find((c) => c.url.searchParams.get("latitude") === "52.9536");
    expect(fc).toBeDefined();
    const audit = s.t.handle.db.select().from(auditLog).all().filter((a) => a.action === "race.forecast_place");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "user", target: `race:${k}` });
    expect(JSON.parse(audit[0]?.result ?? "{}")).toMatchObject({ old: { place: null }, new: { place: "Nottingham", name: "Nottingham, England, United Kingdom" } });
  });

  it("a place that cannot be found is refused, nothing is saved and nothing is audited", async () => {
    const s = await setup();
    const k = s.keyOf("Rhino");
    const res = await s.put(k, "Nowhereville");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("Forecast place not found: Nowhereville");
    expect(s.t.handle.db.select().from(raceMeta).all().filter((m) => m.metaKey === k)).toHaveLength(0);
    expect(s.t.handle.db.select().from(auditLog).all().filter((a) => a.action === "race.forecast_place")).toHaveLength(0);
  });

  it("an empty place removes the manual place, audited, and the race goes back to the automatic order", async () => {
    const s = await setup();
    const k = s.keyOf("Rhino");
    await s.put(k, "Nottingham");
    const res = await s.put(k, "");
    expect(res.status).toBe(200);
    const w = forecastPlaceResponseSchema.parse(await res.json()).weather;
    expect(w.manualPlace).toBeNull();
    expect(w.place).toMatchObject({ state: "found", source: "title" });
    expect(s.t.handle.db.select().from(raceMeta).all().filter((m) => m.metaKey === k)).toHaveLength(0);
    expect(s.t.handle.db.select().from(auditLog).all().filter((a) => a.action === "race.forecast_place")).toHaveLength(2);
  });

  it("saving the priority later does not drop the manual place", async () => {
    const s = await setup();
    const k = s.keyOf("Rhino");
    await s.put(k, "Nottingham");
    const clear = await req(s.t.app, "/api/races/meta", { method: "PUT", headers: { cookie: s.t.cookie, "x-csrf-token": s.t.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ key: k, priority: null, type: null }) });
    expect(clear.status).toBe(200);
    expect((await s.weatherOf(k)).manualPlace).toBe("Nottingham");
  });

  it("says the place was not found when no town can be matched, and fetches no forecast", async () => {
    const s = await setup({ places: {} });
    await s.t.weather.tick();
    const w = await s.weatherOf(s.keyOf("Rhino"));
    expect(w.place).toEqual({ state: "not_found" });
    expect(w.forecast).toBeNull();
    expect(s.meteo.forecastCalls()).toHaveLength(0);
  });

  it("a lookup that fails to connect is pending with a reason, then retried later, not marked not found", async () => {
    const s = await setup();
    s.meteo.state.failGeocode = true;
    await s.t.weather.tick();
    expect((await s.weatherOf(s.keyOf("Rhino"))).place).toEqual({ state: "pending", reason: "Could not reach Open-Meteo." });
    s.meteo.state.failGeocode = false;
    s.clock.now = new Date(NOW0.getTime() + 30 * 60_000);
    await s.t.weather.tick();
    expect((await s.weatherOf(s.keyOf("Rhino"))).place).toMatchObject({ state: "found" });
  });
});

describe("the forecast sync", () => {
  it("fetches for a race inside 14 days with the right query, in mph, with timezone=auto, and caches it", async () => {
    const s = await setup();
    await s.t.weather.tick();
    const calls = s.meteo.forecastCalls();
    expect(calls).toHaveLength(1);
    const q = calls[0]?.url.searchParams;
    expect(q?.get("hourly")).toBe("temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,relative_humidity_2m");
    expect(q?.get("wind_speed_unit")).toBe("mph");
    expect(q?.get("temperature_unit")).toBe("celsius");
    expect(q?.get("precipitation_unit")).toBe("mm");
    expect(q?.get("timezone")).toBe("auto");
    expect([q?.get("start_date"), q?.get("end_date")]).toEqual(["2026-11-14", "2026-11-14"]);
    expect(q?.get("latitude")).toBe("52.9266");
    const w = await s.weatherOf(s.keyOf("Rhino"));
    expect(w.forecast?.atStart).toMatchObject({ time: "09:00", temperatureC: 9, feelsLikeC: 6, windMph: 14, gustMph: 26, windDir: "W", windDirDeg: 270, rainChancePct: 40, rainMm: 0.2, description: "Light rain", isStart: true });
    expect(w.forecast?.strip.map((h) => h.time)).toEqual(["07:00", "08:00", "09:00", "10:00", "11:00", "12:00"]);
    expect(w).toMatchObject({ inWindow: true, startLocal: "09:00", startUnverified: false, waiting: false });
    // Reading it again makes no request: the screens use the cache.
    await s.weatherOf(s.keyOf("Rhino"));
    expect(s.meteo.forecastCalls()).toHaveLength(1);
  });

  it("makes no forecast request for a race outside the 14 day window, and says when it becomes available", async () => {
    const s = await setup();
    await s.t.weather.tick();
    const brighton = s.keyOf("Brighton");
    const w = await s.weatherOf(brighton);
    expect(w).toMatchObject({ inWindow: false, forecast: null, waiting: false, availableFrom: "2027-03-21" });
    expect(s.meteo.forecastCalls().every((c) => c.url.searchParams.get("start_date") === "2026-11-14")).toBe(true);
    // Day 15 is outside, day 14 is inside.
    const k15 = s.addRace({ title: "Fifteen 10K", date: "2026-11-22", location: "52.9,-1.1" });
    const k14 = s.addRace({ title: "Fourteen 10K", date: "2026-11-21", location: "52.9,-1.1" });
    await s.t.weather.tick();
    expect((await s.weatherOf(k15)).forecast).toBeNull();
    expect((await s.weatherOf(k14)).forecast).not.toBeNull();
    expect(s.meteo.forecastCalls().map((c) => c.url.searchParams.get("start_date"))).not.toContain("2026-11-22");
  });

  it("refreshes at most every 3 hours", async () => {
    const s = await setup();
    await s.t.weather.tick();
    s.clock.now = new Date(NOW0.getTime() + (3 * 60 - 1) * 60_000);
    await s.t.weather.tick();
    expect(s.meteo.forecastCalls()).toHaveLength(1);
    s.clock.now = new Date(NOW0.getTime() + 3 * 60 * 60_000);
    await s.t.weather.tick();
    expect(s.meteo.forecastCalls()).toHaveLength(2);
  });

  it("a failed refresh keeps the last forecast with its age, retries on the next run, never goes blank", async () => {
    const s = await setup();
    await s.t.weather.tick();
    s.meteo.state.failForecast = true;
    s.clock.now = new Date(NOW0.getTime() + 3 * 60 * 60_000);
    await s.t.weather.tick();
    const w = await s.weatherOf(s.keyOf("Rhino"));
    expect(w.forecast).toMatchObject({ ageMinutes: 180, refreshFailed: true, stale: false, reason: "Open-Meteo answered with an error (500)." });
    expect(w.forecast?.atStart?.temperatureC).toBe(9);
    // Not hammered: the next run inside 25 minutes does nothing, the one after it retries.
    const n = s.meteo.forecastCalls().length;
    s.clock.now = new Date(s.clock.now.getTime() + 10 * 60_000);
    await s.t.weather.tick();
    expect(s.meteo.forecastCalls()).toHaveLength(n);
    s.meteo.state.failForecast = false;
    s.clock.now = new Date(s.clock.now.getTime() + 20 * 60_000);
    await s.t.weather.tick();
    expect(s.meteo.forecastCalls()).toHaveLength(n + 1);
    expect((await s.weatherOf(s.keyOf("Rhino"))).forecast).toMatchObject({ refreshFailed: false, reason: null });
  });

  it("is stale after 6 hours without a good fetch, and still shows the figures", async () => {
    const s = await setup();
    await s.t.weather.tick();
    s.meteo.state.failForecast = true;
    s.clock.now = new Date(NOW0.getTime() + 7 * 60 * 60_000);
    await s.t.weather.tick();
    const w = await s.weatherOf(s.keyOf("Rhino"));
    expect(w.forecast).toMatchObject({ stale: true, ageMinutes: 420 });
    expect(w.forecast?.atStart).not.toBeNull();
  });

  it("a first fetch that fails shows waiting with no forecast, and partial success is recorded like the other kinds", async () => {
    const s = await setup();
    s.addRace({ title: "Coordinates Run", date: "2026-11-15", location: "52.95, -1.15" });
    // Fail only the second race's forecast.
    let n = 0;
    const inner = s.meteo.fn;
    const flaky = (async (u: URL | string | Request, i?: RequestInit) => {
      const url = new URL(String(u instanceof Request ? u.url : u));
      if (url.pathname === "/v1/forecast" && ++n === 2) return new Response("x", { status: 503 });
      return inner(u, i);
    }) as typeof fetch;
    const t2 = await makeGarminApp({ clock: () => NOW0, weatherFetch: flaky });
    await t2.post("/api/sync/garmin");
    t2.handle.db.insert(race).values({ eventKey: "2026-11-15|Coordinates Run", title: "Coordinates Run", date: "2026-11-15", startTimeLocal: "09:00", timeZone: "Europe/London", distanceM: 10_000, goalTimeSeconds: 3000, isRace: true, primaryEvent: false, subscribed: false, location: "52.95, -1.15", url: null, active: true, firstSeen: NOW0.toISOString(), lastSeen: NOW0.toISOString() }).run();
    await t2.weather.tick();
    const rows = t2.handle.db.select().from(raceForecast).all();
    expect(rows.filter((r) => r.fetchedAt)).toHaveLength(1);
    expect(rows.filter((r) => r.lastError)).toHaveLength(1);
    const job = t2.handle.db.select().from(syncState).all().find((r) => r.job === "weather");
    expect(job?.lastOk).toBe(NOW0.toISOString());
    expect(job?.detail).toBe("1 of 2 forecasts failed: Open-Meteo answered with an error (503).");
    const failed = rows.find((r) => r.lastError);
    const w = await (async () => raceWeatherSchema.parse(await (await t2.get(`/api/races/weather?race=${encodeURIComponent(failed?.raceKey ?? "")}`)).json()))();
    expect(w).toMatchObject({ forecast: null, waiting: true });
  });

  it("forgets the forecast and place of a race that is over", async () => {
    const s = await setup();
    await s.t.weather.tick();
    s.clock.now = new Date(`2026-11-16T12:00:00Z`);
    await s.t.weather.tick();
    expect(s.t.handle.db.select().from(raceForecast).all().find((r) => r.raceKey.includes("Rhino"))).toBeUndefined();
  });
});

describe("start times and time zones", () => {
  it("a race abroad uses its own start time and the zone of the forecast, and flags an unverified start", async () => {
    const s = await setup({ tz: "Europe/Brussels" });
    const k = s.addRace({ title: "Antwerp Half", date: "2026-11-12", location: "Antwerp, BE", startTimeLocal: "01:30", timeZone: "Europe/Paris" });
    await s.t.weather.tick();
    const w = await s.weatherOf(k);
    expect(w).toMatchObject({ startLocal: "01:30", startUnverified: true, raceTimeZone: "Europe/Paris", forecastTimeZone: "Europe/Brussels" });
    expect(w.forecast?.atStart?.time).toBe("01:00");
    expect(w.forecast?.strip.map((h) => h.time)).toEqual(["00:00", "01:00", "02:00", "03:00", "04:00"]);
  });

  it("Sydney: the start in the race's zone, 06:30 Australia/Sydney, picks the 06:00 hour there", async () => {
    const s = await setup({ tz: "Australia/Sydney" });
    const k = s.addRace({ title: "Sydney 10K", date: "2026-11-20", location: "Sydney, AU", startTimeLocal: "06:30", timeZone: "Australia/Sydney" });
    await s.t.weather.tick();
    const w = await s.weatherOf(k);
    expect(w.forecast?.atStart).toMatchObject({ time: "06:00", temperatureC: 6 });
    expect(w.forecast?.strip.map((h) => h.time)).toEqual(["04:00", "05:00", "06:00", "07:00", "08:00", "09:00"]);
  });

  it("when the forecast zone differs from the race zone, the start is converted, not just copied", async () => {
    // The place resolves to a zone 11 hours behind the race's: 06:30 Sydney is 19:30 the day before in London, a day with no hours stored.
    const s = await setup({ tz: "Europe/London" });
    const k = s.addRace({ title: "Odd 10K", date: "2026-11-20", location: "Nottingham, GB", startTimeLocal: "06:30", timeZone: "Australia/Sydney" });
    await s.t.weather.tick();
    const w = await s.weatherOf(k);
    expect(w.forecast).not.toBeNull();
    expect(w.forecast?.atStart).toBeNull();
    expect(w.forecast?.strip).toEqual([]);
  });

  it("no start time: the morning is shown and no start hour is claimed", async () => {
    const s = await setup();
    const k = s.addRace({ title: "Open 10K", date: "2026-11-16", location: "Nottingham, GB", startTimeLocal: null, timeZone: null });
    await s.t.weather.tick();
    const w = await s.weatherOf(k);
    expect(w.startLocal).toBeNull();
    expect(w.forecast?.atStart).toBeNull();
    expect(w.forecast?.strip.map((h) => h.time)).toEqual(["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00"]);
  });
});

describe("Today, the AI tool and what is sent", () => {
  it("adds one factual line under the next race when it is within 7 days", async () => {
    const s = await setup();
    await s.t.weather.tick();
    const today = todayResponseSchema.parse(await (await s.t.get("/api/today")).json());
    expect(today.raceForecast).toBe("Forecast Sat 14/11 09:00: 9C, wind 14 mph W, rain chance 40 percent");
  });

  it("has no line when the race is 8 or more days away, or has no forecast yet", async () => {
    const s = await setup();
    await s.t.weather.tick();
    expect(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).raceForecast).not.toBeNull();
    s.clock.now = new Date("2026-11-06T12:00:00Z");
    expect(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).raceForecast).toBeNull();
    const fresh = await setup();
    expect(todayResponseSchema.parse(await (await fresh.t.get("/api/today")).json()).raceForecast).toBeNull();
  });

  it("the line says when it was fetched once it is stale", async () => {
    const s = await setup();
    await s.t.weather.tick();
    s.meteo.state.failForecast = true;
    s.clock.now = new Date(NOW0.getTime() + 7 * 60 * 60_000);
    const line = todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).raceForecast;
    expect(line).toBe("Forecast Sat 14/11 09:00: 9C, wind 14 mph W, rain chance 40 percent (fetched 12:00)");
  });

  it("get_race_weather returns the cached figures with their source and time, and makes no request", async () => {
    const s = await setup();
    await s.t.weather.tick();
    const n = s.meteo.calls.length;
    const out = runTool("get_race_weather", { race: "next" }, { db: s.t.handle.db, now: NOW0 });
    expect(out).toContain('<data source="get_race_weather"');
    expect(out).toContain("Open-Meteo.com");
    expect(out).toContain('"windDir":"W"');
    expect(out).toContain(NOW0.toISOString());
    expect(runTool("get_race_weather", { race: "nothing like it" }, { db: s.t.handle.db, now: NOW0 })).toContain("No race matches");
    expect(s.meteo.calls).toHaveLength(n);
  });

  it("sends only a place name, or coordinates and a date, with a generic User-Agent and no other header", async () => {
    const s = await setup();
    await s.put(s.keyOf("Rhino"), "Nottingham");
    await s.t.weather.tick();
    expect(s.meteo.calls.length).toBeGreaterThan(2);
    for (const c of s.meteo.calls) {
      expect(c.headers).toEqual({ "user-agent": USER_AGENT, accept: "application/json" });
      expect(USER_AGENT).not.toMatch(/@|mark|hurts/i);
      const keys = [...c.url.searchParams.keys()].sort();
      const geocode = c.url.hostname === "geocoding-api.open-meteo.com";
      expect(keys).toEqual(geocode ? ["count", "format", "language", "name"] : ["end_date", "hourly", "latitude", "longitude", "precipitation_unit", "start_date", "temperature_unit", "timezone", "wind_speed_unit"]);
      expect(c.url.protocol).toBe("https:");
      expect(c.url.href).not.toMatch(/@|mark|hurts|garmin|token|key=|pw/i);
      if (!geocode) expect(c.url.searchParams.get("longitude")).toMatch(/^-?\d{1,3}(\.\d{1,4})?$/);
    }
  });

  it("uses no advice wording in anything it returns", async () => {
    const s = await setup();
    await s.t.weather.tick();
    const k = s.keyOf("Rhino");
    const text = [
      await (await s.t.get(`/api/races/weather?race=${encodeURIComponent(k)}`)).text(),
      String(todayResponseSchema.parse(await (await s.t.get("/api/today")).json()).raceForecast),
      runTool("get_race_weather", { race: "next" }, { db: s.t.handle.db, now: NOW0 }),
    ].join("\n");
    expect(text).not.toMatch(ADVICE_WORDS);
  });
});
